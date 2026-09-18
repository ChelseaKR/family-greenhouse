/**
 * Household audit log (#675) — the DynamoDB half. The vocabulary, the
 * sanitiser and the reader's view live in `models/householdAudit.ts`.
 *
 * Storage: one append-only partition per household,
 * `PK = HOUSEHOLD#{id}#AUDIT`, `SK = AUDIT#{occurredAt}#{uuid}`, each row
 * carrying a `ttl` of AUDIT_RETENTION_DAYS. Rows are only ever Put (under
 * `attribute_not_exists`, so nothing can overwrite one), expired by TTL, or
 * erased with the whole household; nothing updates them.
 *
 * Writes never fail the mutation they describe. The action has already
 * happened by the time the entry is written, and turning a committed member
 * removal or an applied Stripe event into an error would be worse than the
 * missing line. But a missing line must not be silent either:
 *
 *   - the failure is logged at error level as `household_audit.write_failed`
 *     (household and kind only), and
 *   - the next entry this container writes for that household carries
 *     `gapBefore: true`, which the admin page renders as "something may be
 *     missing here".
 *
 * The gap marker is per Lambda container. A failure in one container followed
 * by the next write in another leaves no marker; the error log line is the
 * record of that case.
 */
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import {
  AUDIT_SORT_PREFIX,
  auditPartitionKey,
  billingAuditEntries,
  buildAuditItem,
  isAuditItemExpired,
  type RecordHouseholdAuditInput,
} from '../models/householdAudit.js';

export const HOUSEHOLD_AUDIT_WRITE_FAILED = 'household_audit.write_failed';

/** Households whose last audit write in this container failed. */
const householdsWithGap = new Set<string>();

/** Test hook: forget any gap this container is carrying. */
export function __resetAuditGapsForTests(): void {
  householdsWithGap.clear();
}

/**
 * Append one entry. Resolves in every case — see the module comment for what
 * happens to a failure instead of throwing.
 */
export async function recordHouseholdAudit(
  input: RecordHouseholdAuditInput,
  now: Date = new Date()
): Promise<void> {
  try {
    const gapBefore = householdsWithGap.has(input.householdId);
    const { item, dropped } = buildAuditItem(input, { id: uuid(), now, gapBefore });
    if (dropped.length > 0) {
      // Key names only. The value is exactly what must not reach a log.
      logger.warn(
        { householdId: input.householdId, kind: input.kind, dropped },
        'household_audit.detail_dropped'
      );
    }
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    if (gapBefore) householdsWithGap.delete(input.householdId);
  } catch (err) {
    householdsWithGap.add(input.householdId);
    logger.error(
      { err: (err as Error).message, householdId: input.householdId, kind: input.kind },
      HOUSEHOLD_AUDIT_WRITE_FAILED
    );
  }
}

/**
 * Record what one applied Stripe event did to the household's plan or
 * payment state (see `billingAuditEntries`). Called by the webhook after the
 * subscription row is written; resolves in every case.
 */
export async function recordBillingTransition(
  householdId: string,
  event: { type: string; data: unknown },
  fields: { planId?: string; status?: string }
): Promise<void> {
  try {
    const previous = (event.data as { previous_attributes?: Record<string, unknown> | null })
      ?.previous_attributes;
    for (const entry of billingAuditEntries(event.type, previous, fields)) {
      await recordHouseholdAudit({ householdId, actor: { type: 'stripe' }, ...entry });
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, householdId, kind: 'billing' },
      HOUSEHOLD_AUDIT_WRITE_FAILED
    );
  }
}

export const AUDIT_PAGE_DEFAULT = 25;
export const AUDIT_PAGE_MAX = 100;

export class AuditCursorError extends Error {
  constructor() {
    super('Invalid audit cursor');
    this.name = 'AuditCursorError';
  }
}

/**
 * An opaque page cursor: the sort key of the last row read. Only the sort key
 * travels — the partition is always rebuilt from the household the request
 * resolved to, so a cursor cannot page another household's log.
 */
function encodeCursor(sk: string): string {
  return Buffer.from(sk, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  const sk = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!sk.startsWith(AUDIT_SORT_PREFIX) || sk.length > 120) throw new AuditCursorError();
  return sk;
}

/**
 * One page of a household's log, newest first. `nextCursor` is null exactly
 * when DynamoDB says there is nothing further. Rows past retention that TTL
 * has not swept yet are left out of the page, so a page can be shorter than
 * `limit` and still have a next one.
 */
export async function listHouseholdAudit(
  householdId: string,
  opts: { limit?: number; cursor?: string | null } = {},
  now: Date = new Date()
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(AUDIT_PAGE_MAX, opts.limit ?? AUDIT_PAGE_DEFAULT));
  const pk = auditPartitionKey(householdId);
  const exclusiveStartKey = opts.cursor ? { PK: pk, SK: decodeCursor(opts.cursor) } : undefined;
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': AUDIT_SORT_PREFIX },
      ScanIndexForward: false,
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    })
  );
  const items = (result.Items ?? []).filter((item) => !isAuditItemExpired(item, now));
  const lastSk: unknown = result.LastEvaluatedKey?.SK;
  return {
    items,
    nextCursor: typeof lastSk === 'string' ? encodeCursor(lastSk) : null,
  };
}
