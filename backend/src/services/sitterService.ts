/**
 * Plant-sitter links: a no-account, time-boxed way to let a neighbour or
 * friend see a household's due tasks and check them off while the household
 * is away — without creating an account or joining the household.
 *
 * Security model (mirrors householdService invites, hardened further):
 *   - The token is 256 bits of CSPRNG entropy (crypto.randomBytes(32), hex).
 *     That's double the 128-bit invite code and far beyond brute-force even
 *     from a leaked log line or DDB dump. The token is the ONLY secret — it
 *     grants exactly one household's due-task view + completion, nothing else.
 *   - Rows carry a DynamoDB `ttl` so expired links are swept automatically;
 *     `getActiveLink` ALSO re-checks `expiresAt` and `status` on every read so
 *     a not-yet-swept row can never be honoured past its window (defence in
 *     depth — never rely on the TTL sweeper for correctness).
 *   - Links are revocable: `status: 'revoked'` short-circuits validation
 *     immediately, before the TTL would otherwise expire the row.
 *   - Validation is generic: any failure (missing / expired / revoked) returns
 *     null and the handler answers a single 404/410, so the public endpoint
 *     can't be used as a token-existence oracle.
 *
 * Row shape: PK = `SITTER#{token}`, SK = 'METADATA'. The token is the
 * partition key directly (same as INVITE#{code}) — a sitter request is a
 * single GetItem, no scan, no enumeration surface.
 */
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { DynamoDBItem } from '../models/types.js';

export type SitterLinkStatus = 'active' | 'revoked';

export interface SitterLink {
  /** Opaque id used in the management API (list/revoke). NOT the secret. */
  id: string;
  /** The 256-bit secret token. Returned to the creator exactly once. */
  token: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  /** Start of the creator-set coverage window (ISO). */
  startsAt: string;
  /** End of the coverage window (ISO). Enforced on every public call. */
  expiresAt: string;
  status: SitterLinkStatus;
  /** Friendly, non-PII label the sitter sees (e.g. "The Smiths' plants"). */
  label: string | null;
}

/** A sitter link as exposed to the CREATING household member (never the token
 *  after creation — only `create` returns it). */
export interface SitterLinkSummary {
  id: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  startsAt: string;
  expiresAt: string;
  status: SitterLinkStatus;
  label: string | null;
}

// A buffer past expiresAt before the TTL sweeper may delete the row, so a
// clock-skewed sweep can't drop a link that reads still-active. Reads always
// re-check expiresAt, so the buffer is invisible. Mirrors the vacation TTL.
const TTL_BUFFER_MS = 3 * 24 * 60 * 60 * 1000;

function itemToLink(item: Record<string, unknown>): SitterLink {
  return {
    id: item.id as string,
    token: item.token as string,
    householdId: item.householdId as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as string,
    startsAt: item.startsAt as string,
    expiresAt: item.expiresAt as string,
    status: item.status as SitterLinkStatus,
    label: (item.label as string | null) ?? null,
  };
}

/** Strip the secret token before handing a link to the creating member. */
export function toSummary(link: SitterLink): SitterLinkSummary {
  return {
    id: link.id,
    householdId: link.householdId,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    startsAt: link.startsAt,
    expiresAt: link.expiresAt,
    status: link.status,
    label: link.label,
  };
}

export async function createSitterLink(input: {
  householdId: string;
  createdBy: string;
  startsAt: string;
  expiresAt: string;
  label: string | null;
}): Promise<SitterLink> {
  // 256-bit CSPRNG token — 64 hex chars. randomBytes draws from the OS CSPRNG;
  // do NOT swap this for uuid()/Math.random (predictable / lower entropy).
  const token = randomBytes(32).toString('hex');
  const id = uuid();
  const now = new Date().toISOString();

  const link: SitterLink = {
    id,
    token,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    status: 'active',
    label: input.label,
  };

  const item: DynamoDBItem = {
    PK: `SITTER#${token}`,
    SK: 'METADATA',
    // Mirror onto GSI1 so the household can list its own links in one query
    // (GSI1PK = HOUSEHOLD#{id}#SITTER, newest-first by createdAt).
    GSI1PK: `HOUSEHOLD#${input.householdId}#SITTER`,
    GSI1SK: now,
    entityType: 'SitterLink',
    ...link,
    ttl: Math.floor((Date.parse(input.expiresAt) + TTL_BUFFER_MS) / 1000),
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return link;
}

/**
 * Resolve a token to its link ONLY if it is currently usable: it exists, is
 * active (not revoked), and now is within [startsAt, expiresAt]. Any other
 * state returns null so the caller answers a single generic 404/410 and the
 * endpoint can't be used to probe which tokens exist.
 */
export async function getActiveLink(
  token: string,
  now: Date = new Date()
): Promise<SitterLink | null> {
  // Defensive length/charset gate: a token that can't be one of ours never
  // hits DynamoDB. 64 lowercase hex chars only.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `SITTER#${token}`, SK: 'METADATA' },
    })
  );
  if (!result.Item) return null;

  const link = itemToLink(result.Item);
  if (link.status !== 'active') return null;
  const nowIso = now.toISOString();
  if (nowIso < link.startsAt) return null; // window not started yet
  if (nowIso > link.expiresAt) return null; // expired
  return link;
}

/** All links for a household (active + revoked + not-yet-expired), newest
 *  first, for the management UI. Tokens are included so the service layer can
 *  return them; the HANDLER strips them via toSummary before responding. */
export async function listSitterLinks(householdId: string): Promise<SitterLink[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#SITTER` },
      ScanIndexForward: false,
      Limit: 100,
    })
  );
  return (result.Items ?? []).map(itemToLink);
}

/**
 * Revoke a link by its opaque id, scoped to the household so one household can
 * never revoke another's link. Returns false when no matching active/revoked
 * row exists (→ 404). Idempotent: revoking an already-revoked link succeeds.
 *
 * We look the row up via the household's GSI1 partition (so the caller only
 * needs the non-secret id, never the token) and then conditionally update the
 * base row.
 */
export async function revokeSitterLink(householdId: string, id: string): Promise<boolean> {
  const links = await listSitterLinks(householdId);
  const target = links.find((l) => l.id === id);
  if (!target) return false;

  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `SITTER#${target.token}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :revoked',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked' },
      // Guard against a row deleted (TTL) between the list read and this write.
      ConditionExpression: 'attribute_exists(PK)',
    })
  );
  return true;
}
