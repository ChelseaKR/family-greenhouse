/**
 * Plant Tags (ADR 0016): a printed QR label in the pot that lets anyone in
 * the house — no account, no app, no invite — see who last cared for ONE
 * plant and mark a due task done.
 *
 * Security model: the sitter-link token (services/sitterService.ts) pointed
 * at a permanent, physical, in-home surface, and scoped DOWN rather than
 * across:
 *   - The token is 256 bits of CSPRNG entropy (crypto.randomBytes(32), hex)
 *     and is the partition key directly — a scan is one GetItem, no scan, no
 *     enumeration surface. It is the ONLY secret.
 *   - A tag is scoped to ONE plant and exactly two actions: read that plant's
 *     last care + due tasks, and complete one of those tasks. It can never
 *     reach another plant, a member record, or the household's location.
 *   - There is no expiry (a label in a pot is not a trip), so revocation is
 *     the control: `status: 'revoked'` short-circuits validation on the very
 *     next read, and re-issuing (revoke + fresh token) is one call. Revoked
 *     rows carry a DynamoDB `ttl` so they sweep themselves; reads never rely
 *     on the sweeper for correctness.
 *   - Optional household PIN: stored as a salted scrypt hash on a settings
 *     row (never the PIN), verified server-side on every public call. Wrong
 *     attempts are counted ON THE TAG ROW and lock the tag for a cool-down —
 *     persisted in DynamoDB precisely because the in-memory IP limiter is
 *     per warm container and cannot be the brake for a 10,000-value space.
 *   - Validation is generic: any failure (malformed / missing / revoked)
 *     returns null and the handler answers a single 404, so the public
 *     endpoint can't be used as a token-state oracle.
 *
 * Row shapes:
 *   PK = `PLANTTAG#{token}`, SK = 'METADATA'   — one tag. Mirrored onto GSI1
 *     (GSI1PK = HOUSEHOLD#{id}#PLANTTAG) so a household can list its own.
 *   PK = `HOUSEHOLD#{id}`, SK = 'PLANTTAG#PIN'  — the household PIN hash.
 *     Lives in the household's base partition so account erasure's generic
 *     partition sweep removes it without a special case.
 */
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { PIN_MAX_FAILURES, PIN_LOCKOUT_MS, PIN_RE } from '../models/plantTags.js';
import { DynamoDBItem } from '../models/types.js';
import { logger } from '../utils/logger.js';

export type PlantTagStatus = 'active' | 'revoked';

export interface PlantTag {
  /** Opaque id used in the management API (revoke). NOT the secret. */
  id: string;
  /** The 256-bit secret token — the whole credential a scan presents. */
  token: string;
  householdId: string;
  /** The ONE plant this tag can read and complete tasks for. */
  plantId: string;
  createdBy: string;
  createdAt: string;
  status: PlantTagStatus;
  revokedAt: string | null;
  /** Consecutive wrong-PIN attempts since the last success. Persisted so the
   *  lockout holds across Lambda containers (the IP limiter does not). */
  pinFailures: number;
  /** ISO instant until which PIN attempts on this tag are refused, or null. */
  pinLockedUntil: string | null;
}

/** A tag with the secret and the PIN bookkeeping stripped. */
export interface PlantTagSummary {
  id: string;
  householdId: string;
  plantId: string;
  createdBy: string;
  createdAt: string;
  status: PlantTagStatus;
  revokedAt: string | null;
}

// Re-exported from models/plantTags.ts so existing call sites keep importing
// them from here, while the dev server can reach them without pulling this
// module (and therefore utils/dynamodb.ts) into its import graph.
export { PIN_MAX_FAILURES, PIN_LOCKOUT_MS, PIN_RE, TAG_ACTOR_PREFIX } from '../models/plantTags.js';

// Revoked rows are kept briefly (so a management list can still show "you
// revoked this") and then swept. Reads reject `revoked` regardless of TTL.
const REVOKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const PIN_SK = 'PLANTTAG#PIN';
// scrypt parameters: interactive-strength (N=2^14) — a 4-digit PIN is not a
// password and the lockout, not the KDF, is the real brake; the KDF only
// makes a leaked table useless offline.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;
const HASH_BYTES = 32;

function itemToTag(item: Record<string, unknown>): PlantTag {
  return {
    id: item.id as string,
    token: item.token as string,
    householdId: item.householdId as string,
    plantId: item.plantId as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as string,
    status: item.status as PlantTagStatus,
    revokedAt: (item.revokedAt as string | null) ?? null,
    pinFailures: typeof item.pinFailures === 'number' ? item.pinFailures : 0,
    pinLockedUntil: (item.pinLockedUntil as string | null) ?? null,
  };
}

/** Strip the secret and the PIN bookkeeping. */
export function toSummary(tag: PlantTag): PlantTagSummary {
  return {
    id: tag.id,
    householdId: tag.householdId,
    plantId: tag.plantId,
    createdBy: tag.createdBy,
    createdAt: tag.createdAt,
    status: tag.status,
    revokedAt: tag.revokedAt,
  };
}

/**
 * Mint a tag for a plant. A plant holds at most one ACTIVE tag: any earlier
 * active tag for the same plant is revoked first, so "re-issue" and "issue"
 * are the same call and the old label stops working the moment the new one
 * exists — the one-click rotation the threat model depends on.
 */
export async function issueTag(input: {
  householdId: string;
  plantId: string;
  createdBy: string;
}): Promise<PlantTag> {
  await revokeTagsForPlant(input.householdId, input.plantId);

  // 256-bit CSPRNG token — 64 hex chars. Same source as sitter links; do NOT
  // swap for uuid()/Math.random (predictable / lower entropy).
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const tag: PlantTag = {
    id: uuid(),
    token,
    householdId: input.householdId,
    plantId: input.plantId,
    createdBy: input.createdBy,
    createdAt: now,
    status: 'active',
    revokedAt: null,
    pinFailures: 0,
    pinLockedUntil: null,
  };

  const item: DynamoDBItem = {
    PK: `PLANTTAG#${token}`,
    SK: 'METADATA',
    GSI1PK: `HOUSEHOLD#${input.householdId}#PLANTTAG`,
    GSI1SK: now,
    entityType: 'PlantTag',
    ...tag,
  };
  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return tag;
}

/**
 * Resolve a token to its tag ONLY if it is currently usable (exists and is
 * active). Any other state returns null so the caller answers one generic
 * 404 and the endpoint can't be probed for which tokens exist.
 */
export async function getActiveTag(token: string): Promise<PlantTag | null> {
  // Defensive length/charset gate: a token that can't be one of ours never
  // hits DynamoDB.
  if (!TOKEN_RE.test(token)) return null;
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PLANTTAG#${token}`, SK: 'METADATA' } })
  );
  if (!result.Item) return null;
  const tag = itemToTag(result.Item);
  return tag.status === 'active' ? tag : null;
}

/**
 * Page size for the plant-tag listing. A transport detail, NOT a cap:
 * `listTags` follows `LastEvaluatedKey` to exhaustion.
 *
 * Tags are the sharpest case of the three. They NEVER expire (ADR 0016), the
 * query is newest-first, and `revokeTag`, `revokeTagsCreatedBy` and
 * `revokeTagsForPlant` all read through here — so under a bare `Limit: 500`
 * the labels that dropped off the end were the OLDEST ones, which are exactly
 * the ones physically stuck to pots and least likely to be missed. A departed
 * member's oldest tags survived the removal sweep added for #449.
 */
const TAG_PAGE_SIZE = 500;

/** Every tag row for a household (active + not-yet-swept revoked), newest
 *  first. Tokens are included: the household needs them to print. */
export async function listTags(householdId: string): Promise<PlantTag[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#PLANTTAG` },
        ScanIndexForward: false,
        Limit: TAG_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map(itemToTag);
}

export async function listActiveTags(householdId: string): Promise<PlantTag[]> {
  return (await listTags(householdId)).filter((tag) => tag.status === 'active');
}

async function revokeRow(token: string, now: Date): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PLANTTAG#${token}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :revoked, revokedAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':revoked': 'revoked',
        ':now': now.toISOString(),
        ':ttl': Math.floor((now.getTime() + REVOKED_TTL_MS) / 1000),
      },
      // Guard against a row swept between the list read and this write.
      ConditionExpression: 'attribute_exists(PK)',
    })
  );
}

/**
 * Revoke one tag by its opaque id, scoped to the household so one household
 * can never revoke another's. Returns false when no row matches (→ 404).
 * Idempotent: revoking a revoked tag succeeds.
 */
export async function revokeTag(householdId: string, tagId: string): Promise<boolean> {
  const target = (await listTags(householdId)).find((tag) => tag.id === tagId);
  if (!target) return false;
  await revokeRow(target.token, new Date());
  return true;
}

/**
 * Revoke every ACTIVE tag a given member issued. Called when that member is
 * removed from the household.
 *
 * ADR 0016's argument that issuing a tag is not privilege escalation holds for
 * a CURRENT member — a tag grants strictly less than they already have. It
 * stops holding the moment they are not a member: the tag never expires, so
 * revocation is the only control, and the token is printed on a label they may
 * well have kept (or listed in bulk on the way out). Returns how many were
 * revoked so the caller can tell the household what it cost them.
 */
export async function revokeTagsCreatedBy(householdId: string, userId: string): Promise<number> {
  const active = (await listActiveTags(householdId)).filter((tag) => tag.createdBy === userId);
  const now = new Date();
  for (const tag of active) {
    await revokeRow(tag.token, now);
  }
  return active.length;
}

/** Revoke every ACTIVE tag for a plant. Returns how many were revoked. */
export async function revokeTagsForPlant(householdId: string, plantId: string): Promise<number> {
  const active = (await listActiveTags(householdId)).filter((tag) => tag.plantId === plantId);
  const now = new Date();
  for (const tag of active) {
    await revokeRow(tag.token, now);
  }
  return active.length;
}

// ---------------------------------------------------------------------------
// Household PIN
// ---------------------------------------------------------------------------

interface PinRecord {
  pinHash: string;
  pinSalt: string;
}

async function getPinRecord(householdId: string): Promise<PinRecord | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `HOUSEHOLD#${householdId}`, SK: PIN_SK } })
  );
  const item = result.Item;
  if (!item || typeof item.pinHash !== 'string' || typeof item.pinSalt !== 'string') return null;
  return { pinHash: item.pinHash, pinSalt: item.pinSalt };
}

export interface TagSettings {
  /** Whether scans of this household's tags must present the PIN. */
  pinEnabled: boolean;
}

export async function getTagSettings(householdId: string): Promise<TagSettings> {
  return { pinEnabled: (await getPinRecord(householdId)) !== null };
}

function hashPin(pin: string, salt: string): Buffer {
  return scryptSync(pin, salt, HASH_BYTES, SCRYPT_OPTS);
}

/**
 * Set (4 digits) or clear (null) the household PIN. The PIN itself is never
 * stored — only a salted scrypt hash — so a table dump yields nothing a
 * scanner could type.
 */
export async function setTagPin(
  householdId: string,
  pin: string | null,
  updatedBy: string
): Promise<TagSettings> {
  const now = new Date().toISOString();
  if (pin === null) {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: PIN_SK },
        UpdateExpression: 'REMOVE pinHash, pinSalt SET updatedAt = :now, updatedBy = :by',
        ExpressionAttributeValues: { ':now': now, ':by': updatedBy },
      })
    );
    return { pinEnabled: false };
  }
  if (!PIN_RE.test(pin)) {
    throw new Error('PIN must be exactly four digits');
  }
  const salt = randomBytes(16).toString('hex');
  const item: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: PIN_SK,
    entityType: 'PlantTagPin',
    householdId,
    pinHash: hashPin(pin, salt).toString('hex'),
    pinSalt: salt,
    updatedAt: now,
    updatedBy,
  };
  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return { pinEnabled: true };
}

export type PinVerdict = 'ok' | 'required' | 'wrong' | 'locked';

export interface PinCheck {
  verdict: PinVerdict;
  /** Present when `verdict === 'locked'`. */
  lockedUntil?: string;
}

async function bumpFailures(tag: PlantTag): Promise<number> {
  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PLANTTAG#${tag.token}`, SK: 'METADATA' },
      UpdateExpression: 'ADD pinFailures :one',
      ExpressionAttributeValues: { ':one': 1 },
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    })
  );
  const failures: unknown = result.Attributes?.pinFailures;
  return typeof failures === 'number' ? failures : PIN_MAX_FAILURES;
}

async function lockTag(tag: PlantTag, lockedUntil: string): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PLANTTAG#${tag.token}`, SK: 'METADATA' },
      UpdateExpression: 'SET pinLockedUntil = :until, pinFailures = :zero',
      ExpressionAttributeValues: { ':until': lockedUntil, ':zero': 0 },
      ConditionExpression: 'attribute_exists(PK)',
    })
  );
}

async function clearFailures(tag: PlantTag): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PLANTTAG#${tag.token}`, SK: 'METADATA' },
        UpdateExpression: 'SET pinFailures = :zero REMOVE pinLockedUntil',
        ExpressionAttributeValues: { ':zero': 0 },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  } catch (err) {
    // Best-effort: a stale counter only means one fewer wrong try later.
    logger.warn({ err: (err as Error).message, tagId: tag.id }, 'planttag.pin_reset_failed');
  }
}

/**
 * Check a presented PIN against the household's setting, enforcing the
 * per-tag lockout. Order matters: an existing lock is honoured BEFORE the
 * candidate is examined, so a locked tag cannot be probed at all.
 *
 *   ok       — no PIN set, or the PIN matched
 *   required — a PIN is set and none was presented
 *   wrong    — a PIN was presented and did not match (failure counted)
 *   locked   — too many wrong tries; `lockedUntil` says when to try again
 */
export async function verifyTagPin(
  tag: PlantTag,
  pin: string | undefined,
  now: Date = new Date()
): Promise<PinCheck> {
  const record = await getPinRecord(tag.householdId);
  if (!record) return { verdict: 'ok' };

  const nowIso = now.toISOString();
  if (tag.pinLockedUntil && tag.pinLockedUntil > nowIso) {
    return { verdict: 'locked', lockedUntil: tag.pinLockedUntil };
  }
  if (pin === undefined || pin === '') return { verdict: 'required' };

  const candidate = hashPin(pin, record.pinSalt);
  const expected = Buffer.from(record.pinHash, 'hex');
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  if (matches) {
    if (tag.pinFailures > 0 || tag.pinLockedUntil) await clearFailures(tag);
    return { verdict: 'ok' };
  }

  const failures = await bumpFailures(tag);
  if (failures >= PIN_MAX_FAILURES) {
    const lockedUntil = new Date(now.getTime() + PIN_LOCKOUT_MS).toISOString();
    await lockTag(tag, lockedUntil);
    return { verdict: 'locked', lockedUntil };
  }
  return { verdict: 'wrong' };
}
