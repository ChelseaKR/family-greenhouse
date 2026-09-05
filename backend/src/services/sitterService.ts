/**
 * Plant-sitter links: a no-account, time-boxed way to let a neighbour or
 * friend see a household's due tasks and check them off while the household
 * is away — without creating an account or joining the household.
 *
 * Security model (mirrors householdService invites, hardened further):
 *   - The token is 256 bits of CSPRNG entropy (crypto.randomBytes(32), hex).
 *     That's double the 128-bit invite code and far beyond brute-force even
 *     from a leaked log line. The token is the ONLY secret — it grants exactly
 *     one household's due-task view + completion, nothing else.
 *   - At rest the token is HASHED, never stored (#450). A table export, a
 *     point-in-time restore, or anyone with `dynamodb:Scan` used to walk away
 *     with live, working sitter links; now they get a scrypt digest, the same
 *     as `apiKeys.ts` and `calendarTokens.ts` already gave them.
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
 * Row shape: PK = `SITTER#{scrypt(token)}`, SK = 'METADATA'. Hashing keeps the
 * property that made the plaintext key attractive in the first place — the
 * digest is still the partition key, so a sitter request is still a single
 * GetItem with no scan and no enumeration surface — while removing the one it
 * did not have.
 *
 * Rows written before #450 are keyed by the PLAINTEXT token and carry it as a
 * `token` attribute. They are still resolved (`getActiveLink` falls back to a
 * second point read) so that no link already sitting in somebody's messages
 * breaks, and they are never rewritten: every sitter row carries a DynamoDB
 * `ttl` of `expiresAt` + 3 days, so the last legacy row deletes itself within
 * one link window (90 days at the longest) with nothing to run.
 */
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes, scryptSync } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { DynamoDBItem } from '../models/types.js';

export type SitterLinkStatus = 'active' | 'revoked';

export interface SitterLink {
  /** Opaque id used in the management API (list/revoke). NOT the secret. */
  id: string;
  /**
   * The 256-bit secret token, present ONLY on the object `createSitterLink`
   * returns — that is the one moment it exists in this system. It is not
   * stored, so a link read back out of DynamoDB carries `null` here unless it
   * is a pre-#450 row that still holds its plaintext.
   */
  token: string | null;
  /**
   * The row's own partition-key suffix: the token's scrypt digest on rows
   * written since #450, the plaintext token on rows written before it. It
   * exists so revocation can address the base row of either generation
   * without the household ever holding a token. NEVER put it in a response —
   * for a legacy row it IS the secret; `toSummary` is the only thing that
   * should be handed to a caller.
   */
  keyToken: string;
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

/**
 * Deterministic, memory-hard hash of a sitter token — the row's partition key.
 * Same construction and same reasoning as `apiKeys.hashKey` and
 * `calendarTokens.hashToken`: a per-row random salt (bcrypt/argon2) would make
 * the point read impossible, and a fixed salt costs nothing here because the
 * input is a 256-bit CSPRNG value rather than a human-chosen password, so
 * there is no precomputation to defend against. scrypt rather than SHA-256
 * because the repo's `js/insufficient-password-hash` policy rejects an
 * unsalted digest.
 *
 * The salt is DIFFERENT from every other credential's, so a token minted for
 * one surface can never resolve on another even if it is pasted there.
 */
function hashToken(token: string): string {
  return scryptSync(token, 'family-greenhouse-sitter-v1', 32).toString('hex');
}

function itemToLink(item: Record<string, unknown>): SitterLink {
  // `tokenHash` on rows written since #450; the plaintext `token` on rows
  // written before it. Either way this is exactly the row's PK suffix, which
  // is all revocation needs.
  const keyToken = (item.tokenHash as string | undefined) ?? (item.token as string);
  return {
    id: item.id as string,
    token: (item.token as string | undefined) ?? null,
    keyToken,
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

/** A link as it comes back from `createSitterLink` — the one place the
 *  plaintext token exists, and the only place it is non-null. */
export type MintedSitterLink = SitterLink & { token: string };

export async function createSitterLink(input: {
  householdId: string;
  createdBy: string;
  startsAt: string;
  expiresAt: string;
  label: string | null;
}): Promise<MintedSitterLink> {
  // 256-bit CSPRNG token — 64 hex chars. randomBytes draws from the OS CSPRNG;
  // do NOT swap this for uuid()/Math.random (predictable / lower entropy).
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const id = uuid();
  const now = new Date().toISOString();

  // The item is written field by field rather than spread from the record,
  // because the record carries the plaintext and the row must NOT (#450).
  const item: DynamoDBItem = {
    PK: `SITTER#${tokenHash}`,
    SK: 'METADATA',
    // Mirror onto GSI1 so the household can list its own links in one query
    // (GSI1PK = HOUSEHOLD#{id}#SITTER, newest-first by createdAt).
    GSI1PK: `HOUSEHOLD#${input.householdId}#SITTER`,
    GSI1SK: now,
    entityType: 'SitterLink',
    // Both the PK suffix and the attribute every revoke path reads through.
    // The plaintext appears nowhere on the row.
    tokenHash,
    id,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    status: 'active',
    label: input.label,
    ttl: Math.floor((Date.parse(input.expiresAt) + TTL_BUFFER_MS) / 1000),
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return {
    id,
    token,
    keyToken: tokenHash,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    status: 'active',
    label: input.label,
  };
}

async function readLinkRow(pk: string): Promise<Record<string, unknown> | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: 'METADATA' } })
  );
  return (result?.Item as Record<string, unknown> | undefined) ?? null;
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

  // Hashed row first — that is every link minted since #450. A miss falls back
  // to the pre-#450 plaintext-keyed row so a link already in somebody's
  // messages keeps working. BOTH are GetItem on the partition key, so the
  // fallback costs one extra point read and adds no enumeration surface; and
  // nothing here writes a plaintext row back, so the legacy generation only
  // ever shrinks (every sitter row carries a TTL).
  const item =
    (await readLinkRow(`SITTER#${hashToken(token)}`)) ?? (await readLinkRow(`SITTER#${token}`));
  if (!item) return null;

  const link = itemToLink(item);
  if (link.status !== 'active') return null;
  const nowIso = now.toISOString();
  if (nowIso < link.startsAt) return null; // window not started yet
  if (nowIso > link.expiresAt) return null; // expired
  return link;
}

/**
 * Page size for the sitter-link listing. A transport detail, NOT a cap:
 * `listSitterLinks` follows `LastEvaluatedKey` to exhaustion.
 *
 * It used to be a bare `Limit: 100` on a `ScanIndexForward: false` query, so
 * the household's OLDEST links fell off the end silently. Every revocation
 * path reads through this function — `revokeSitterLink` finds its target in
 * this list (a truncated one answers 404 for a link that is still live), and
 * `revokeSitterLinksCreatedBy` filters it, so a departed member's oldest link
 * survived their removal and the audited count understated what was left
 * behind. A short read is not a failed read: nothing throws, and the caller
 * cannot tell a complete answer from a partial one.
 */
const SITTER_PAGE_SIZE = 100;

/** All links for a household (active + revoked + not-yet-expired), newest
 *  first, for the management UI. Rows carry `keyToken` (the row's own PK
 *  suffix) so the service layer can revoke them; since #450 they carry no
 *  plaintext token at all, and the HANDLER strips both via toSummary. */
export async function listSitterLinks(householdId: string): Promise<SitterLink[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#SITTER` },
        ScanIndexForward: false,
        Limit: SITTER_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map(itemToLink);
}

/**
 * Look a link up by its non-secret id within ONE household's partition. Used
 * by the revoke handler to decide whether the caller may revoke it (admins
 * may revoke any of the household's links; a member only their own). Null
 * when the household has no such link — never reaches across households.
 */
export async function findSitterLink(householdId: string, id: string): Promise<SitterLink | null> {
  const links = await listSitterLinks(householdId);
  return links.find((l) => l.id === id) ?? null;
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
/**
 * Revoke every currently-ACTIVE link a given member created. Called when that
 * member is removed from the household: the link is a whole-household task
 * view plus completion and photo upload, and its holder is whoever the
 * departing member handed it to. Expiry bounds it (7d free / 90d paid) but
 * does not end it today.
 *
 * A read failure PROPAGATES rather than being swallowed into 0 — "we could not
 * look" must never be reported to the caller as "there was nothing to revoke"
 * (ADR 0010), which matters more here than usual because the caller writes the
 * number into an audit line.
 */
export async function revokeSitterLinksCreatedBy(
  householdId: string,
  userId: string
): Promise<number> {
  const links = (await listSitterLinks(householdId)).filter(
    (link) => link.createdBy === userId && link.status === 'active'
  );
  for (const link of links) {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `SITTER#${link.keyToken}`, SK: 'METADATA' },
        UpdateExpression: 'SET #status = :revoked',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked' },
        // Guard against a row swept by TTL between the list read and this write.
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  }
  return links.length;
}

export async function revokeSitterLink(householdId: string, id: string): Promise<boolean> {
  const links = await listSitterLinks(householdId);
  const target = links.find((l) => l.id === id);
  if (!target) return false;

  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `SITTER#${target.keyToken}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :revoked',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked' },
      // Guard against a row deleted (TTL) between the list read and this write.
      ConditionExpression: 'attribute_exists(PK)',
    })
  );
  return true;
}
