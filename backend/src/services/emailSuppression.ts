/**
 * Outbound-email suppression list.
 *
 * Before this existed, nothing in the product ever marked an address
 * undeliverable: a member's email is written once at join time
 * (`householdService.addMember`) and the weekly digest, the yearly recap and
 * the hourly reminder scan re-mailed a hard-bouncing address forever. Sustained
 * bounces are exactly what destroys a sending domain's reputation, and the
 * blast radius is every email the domain sends — including the Cognito
 * password-reset code a locked-out user has to receive.
 *
 * One row per address holds the whole delivery state:
 *
 *   PK = EMAIL#<normalized address>, SK = DELIVERY_STATE
 *
 * `state` is a two-value machine:
 *
 *   - `transient` — we have seen soft bounces (mailbox full, greylisting, a
 *     receiving MTA having a bad afternoon) but the address is still worth
 *     trying. The row carries a rolling `softBounceCount` and a TTL so a bad
 *     week ages out on its own. Sending is NOT blocked in this state.
 *   - `suppressed` — stop sending, permanently, until a human intervenes.
 *     Reached by a hard bounce, by a complaint, or by soft bounces crossing
 *     `SOFT_BOUNCE_LIMIT` inside the rolling window. Suppressed rows carry no
 *     TTL: an address that does not exist does not start existing because a
 *     week went by.
 *
 * Reads never collapse a failure into "not suppressed". `checkAddress` returns
 * an explicit `{ status: 'unknown' }` when the lookup itself fails, and the
 * send path treats unknown as "don't claim a delivery" rather than as a green
 * light or as a permanent block (see ADR 0022 and ADR 0010).
 */
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { audit } from '../utils/auditLog.js';
import { logger } from '../utils/logger.js';

/** Why an address stopped receiving mail. */
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'soft_bounce_limit';

/**
 * Soft bounces tolerated inside the rolling window before the address is
 * suppressed. Five weekly digests in a row failing transiently is no longer
 * "transient" — it is an address we are damaging our reputation on.
 */
export const SOFT_BOUNCE_LIMIT = 5;

/** Rolling window for the soft-bounce counter. */
const TRANSIENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface EmailDeliveryState {
  email: string;
  state: 'transient' | 'suppressed';
  /** Present only when `state === 'suppressed'`. */
  reason?: SuppressionReason;
  /** Provider-supplied classification, e.g. `Permanent/General`. Never a body. */
  detail?: string;
  softBounceCount: number;
  firstEventAt: string;
  lastEventAt: string;
  suppressedAt?: string;
}

/**
 * The answer to "may we mail this address right now?".
 *
 * `unknown` is a real, distinct answer — the store was unreachable — and is
 * deliberately NOT folded into `sendable`. A caller that treats it as sendable
 * risks mailing a suppressed address; one that treats it as suppressed drops
 * mail during an unrelated DynamoDB blip. `emailNotifier` does neither: it
 * declines to send and reports the send as not accepted, so the scheduled
 * jobs retry on their next run.
 */
export type AddressStatus =
  | { status: 'sendable' }
  | { status: 'suppressed'; state: EmailDeliveryState }
  | { status: 'unknown'; reason: 'lookup_failed' };

/**
 * Lowercase and trim. The domain half is case-insensitive by RFC; the local
 * part technically is not, but no mail provider in practice treats
 * `Sam@` and `sam@` as different mailboxes, and matching SES's event payload
 * against a stored address is worth more here than RFC purity.
 */
export function normalizeAddress(email: string): string {
  return email.trim().toLowerCase();
}

function key(email: string): { PK: string; SK: string } {
  return { PK: `EMAIL#${normalizeAddress(email)}`, SK: 'DELIVERY_STATE' };
}

function toState(item: Record<string, unknown> | undefined): EmailDeliveryState | null {
  if (!item || typeof item.email !== 'string') return null;
  const state = item.state === 'suppressed' ? 'suppressed' : 'transient';
  return {
    email: item.email,
    state,
    reason: typeof item.reason === 'string' ? (item.reason as SuppressionReason) : undefined,
    detail: typeof item.detail === 'string' ? item.detail : undefined,
    softBounceCount: Number(item.softBounceCount ?? 0),
    firstEventAt: typeof item.firstEventAt === 'string' ? item.firstEventAt : '',
    lastEventAt: typeof item.lastEventAt === 'string' ? item.lastEventAt : '',
    suppressedAt: typeof item.suppressedAt === 'string' ? item.suppressedAt : undefined,
  };
}

/**
 * Point read for one address. Called on every outbound send, so it is a single
 * `GetItem` against the row's own partition — no scan, no index.
 */
export async function checkAddress(email: string): Promise<AddressStatus> {
  let item: Record<string, unknown> | undefined;
  try {
    const result = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: key(email) }));
    item = result.Item as Record<string, unknown> | undefined;
  } catch (err) {
    // Named failure state, never `sendable`: "we could not look" and "we
    // looked and it is fine" must not be the same answer (ADR 0010).
    logger.warn({ err: (err as Error).message }, 'email_suppression.lookup_failed');
    return { status: 'unknown', reason: 'lookup_failed' };
  }
  const state = toState(item);
  if (state && state.state === 'suppressed') {
    return { status: 'suppressed', state };
  }
  return { status: 'sendable' };
}

/**
 * Keys per `BatchGetItem` request. A transport limit imposed by DynamoDB, NOT
 * a cap on the roster: `getDeliveryStates` chunks its keys and merges the
 * responses, so a roster of any size is looked up in full.
 *
 * This used to be a hard refusal — `if (unique.length > 100) return
 * { status: 'unknown' }` — justified by a constant in another file:
 * `householdService.MEMBER_QUERY_LIMIT` was read as a bound on the roster. It
 * is not one, and its own docstring says so; it is that query's PAGE SIZE, and
 * the query follows `LastEvaluatedKey` to exhaustion. ADR 0014 then made Garden
 * and Greenhouse membership unlimited, so the roster handed to this function
 * has no bound at all. A household above 100 distinct member addresses got
 * `emailStatus: 'unknown'` on every row forever, and the hard-bounce fact
 * `getHouseholdMembersPublic` exists to surface simply stopped being visible.
 *
 * That is the same cross-file coupling the member query and the caretaker,
 * kiosk, plant-tag, sitter, API-key and space listings each removed by paging
 * (#527, #529). This was the surviving reader of it.
 */
const BATCH_GET_KEY_LIMIT = 100;

/**
 * Batch variant for roster-shaped views (the household members list). Returns
 * a single `unknown` for the whole batch rather than a partially-populated map:
 * a map that silently omitted the addresses DynamoDB could not return would
 * render "everyone is reachable" out of a failed read.
 *
 * All-or-nothing spans the chunks too: one chunk that throws or leaves keys
 * unprocessed makes the WHOLE roster `unknown`, not just its own slice — a
 * merged map missing one chunk is exactly the partial map the paragraph above
 * refuses, and the earlier chunks' `ok` rows would be the ones rendered.
 */
export async function getDeliveryStates(
  emails: readonly string[]
): Promise<{ status: 'ok'; states: Map<string, EmailDeliveryState> } | { status: 'unknown' }> {
  const unique = [...new Set(emails.map(normalizeAddress))].filter((e) => e.length > 0);
  if (unique.length === 0) return { status: 'ok', states: new Map() };

  const states = new Map<string, EmailDeliveryState>();
  for (let offset = 0; offset < unique.length; offset += BATCH_GET_KEY_LIMIT) {
    const chunk = unique.slice(offset, offset + BATCH_GET_KEY_LIMIT);
    try {
      const result = await dynamodb.send(
        new BatchGetCommand({
          RequestItems: {
            [TABLE_NAME]: { Keys: chunk.map((email) => key(email)) },
          },
        })
      );
      const unprocessed = result.UnprocessedKeys?.[TABLE_NAME]?.Keys?.length ?? 0;
      if (unprocessed > 0) {
        logger.warn({ unprocessed, keys: unique.length }, 'email_suppression.batch_incomplete');
        return { status: 'unknown' };
      }
      for (const item of result.Responses?.[TABLE_NAME] ?? []) {
        const state = toState(item as Record<string, unknown>);
        if (state) states.set(normalizeAddress(state.email), state);
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, keys: unique.length },
        'email_suppression.batch_failed'
      );
      return { status: 'unknown' };
    }
  }
  return { status: 'ok', states };
}

async function suppress(
  email: string,
  reason: SuppressionReason,
  detail: string | undefined,
  now: Date
): Promise<EmailDeliveryState> {
  const normalized = normalizeAddress(email);
  const iso = now.toISOString();
  const state: EmailDeliveryState = {
    email: normalized,
    state: 'suppressed',
    reason,
    detail,
    softBounceCount: 0,
    firstEventAt: iso,
    lastEventAt: iso,
    suppressedAt: iso,
  };
  // Full overwrite: a suppression supersedes whatever transient counter was
  // there, and the PutCommand drops the TTL the transient row carried, so a
  // suppressed address never silently expires back into the send path.
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...key(normalized),
        entityType: 'EmailDeliveryState',
        ...state,
      },
    })
  );
  audit('email.suppressed', {
    targetId: normalized,
    metadata: { reason, detail: detail ?? null },
  });
  return state;
}

/** A permanent bounce: the mailbox does not exist, or the domain rejects us. */
export function recordHardBounce(
  email: string,
  detail?: string,
  now: Date = new Date()
): Promise<EmailDeliveryState> {
  return suppress(email, 'hard_bounce', detail, now);
}

/**
 * A spam complaint. Suppressed immediately and permanently: a recipient who
 * pressed "report spam" has withdrawn consent, and continuing to mail them is
 * both the fastest way to lose a sending domain and the wrong thing to do.
 * Only the recipient themselves can lift it (see `clearSuppression`).
 */
export function recordComplaint(
  email: string,
  detail?: string,
  now: Date = new Date()
): Promise<EmailDeliveryState> {
  return suppress(email, 'complaint', detail, now);
}

/**
 * A transient bounce. Counts against a rolling budget instead of suppressing:
 * a full mailbox on Monday should not cost someone their reminders forever.
 * Crossing `SOFT_BOUNCE_LIMIT` inside the window promotes to a suppression.
 */
export async function recordSoftBounce(
  email: string,
  detail?: string,
  now: Date = new Date()
): Promise<EmailDeliveryState> {
  const normalized = normalizeAddress(email);
  const iso = now.toISOString();
  const ttl = Math.floor(now.getTime() / 1000) + TRANSIENT_TTL_SECONDS;

  let updated: Record<string, unknown> | undefined;
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key(normalized),
        UpdateExpression:
          'SET #state = :transient, #entityType = :entityType, #email = :email, ' +
          '#lastEventAt = :now, #detail = :detail, #ttl = :ttl, ' +
          '#firstEventAt = if_not_exists(#firstEventAt, :now) ADD #softBounceCount :one',
        // An already-suppressed address must not be walked back to `transient`
        // by a late transient event for an older message.
        ConditionExpression: 'attribute_not_exists(#state) OR #state = :transient',
        // Every attribute is aliased rather than spelled inline: `status`-,
        // `name`- and `value`-shaped words are DynamoDB reserved words and the
        // failure mode is a runtime ValidationException, not a compile error.
        ExpressionAttributeNames: {
          '#state': 'state',
          '#ttl': 'ttl',
          '#entityType': 'entityType',
          '#email': 'email',
          '#detail': 'detail',
          '#lastEventAt': 'lastEventAt',
          '#firstEventAt': 'firstEventAt',
          '#softBounceCount': 'softBounceCount',
        },
        ExpressionAttributeValues: {
          ':transient': 'transient',
          ':entityType': 'EmailDeliveryState',
          ':email': normalized,
          ':now': iso,
          ':detail': detail ?? null,
          ':ttl': ttl,
          ':one': 1,
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    updated = result.Attributes as Record<string, unknown> | undefined;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Already suppressed — nothing to escalate. Report the settled state.
      const current = await checkAddress(normalized);
      if (current.status === 'suppressed') return current.state;
      throw err;
    }
    throw err;
  }

  const state = toState(updated);
  if (!state) {
    // The update succeeded but returned nothing usable. Do not invent a
    // count; let the caller retry rather than record a fictional state.
    throw new Error('email_suppression.soft_bounce_missing_attributes');
  }
  if (state.softBounceCount >= SOFT_BOUNCE_LIMIT) {
    return suppress(normalized, 'soft_bounce_limit', detail, now);
  }
  return state;
}

/**
 * A confirmed delivery clears a transient counter — the address demonstrably
 * works. It deliberately does NOT clear a suppression: a hard bounce or a
 * complaint is lifted only by `clearSuppression`.
 */
export async function recordDelivery(email: string): Promise<void> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: key(email),
        ConditionExpression: '#state = :transient',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':transient': 'transient' },
      })
    );
  } catch (err) {
    // No row, or a suppressed row: both are the expected steady state.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

/**
 * Un-suppress. The only way back onto the send list, and deliberately a
 * deliberate human act rather than a timer — see ADR 0022 for the policy.
 * `actorId` is the authenticated user asking for it; the recipient themselves
 * is the only principal the API exposes this to.
 */
export async function clearSuppression(email: string, actorId: string): Promise<void> {
  const normalized = normalizeAddress(email);
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: key(normalized),
    })
  );
  audit('email.suppression_cleared', { actorId, targetId: normalized });
}
