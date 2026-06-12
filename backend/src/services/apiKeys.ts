/**
 * Per-household API keys for the public API (read scopes plus the opt-in
 * `write:tasks` scope). Each key is plan-gated (Greenhouse only), revocable,
 * and stored as a SHA-256 hash so the plaintext never lives at rest.
 *
 * Key format: `fg_<24-byte hex>`. The `fg_` prefix is stable for log
 * grepping and so users can spot a key in a screenshot. The 24-byte body is
 * 192 bits of entropy — overkill for the threat model (rate-limited public
 * read API) and right-sized for "feels random" to a human.
 *
 * Storage:
 *   PK: HOUSEHOLD#{id}
 *   SK: APIKEY#{keyId}
 *   GSI3PK: APIKEY_HASH#{sha256(plaintext)}   <- index for lookup-by-key
 *   GSI3SK: HOUSEHOLD#{id}
 *
 * The GSI3 lookup means we can verify a key on incoming requests with a
 * single point read. We never store the plaintext; once the user gets the
 * "copy your key" screen, we lose it.
 *
 * Per-key scopes (`read:plants` etc.) live as an array attribute on the same
 * row. Keys created before scopes existed have no attribute; we read those as
 * "all read scopes" so the change is backward-compatible.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { v4 as uuid } from 'uuid';

/**
 * The least-privilege scopes a public-API key can carry. Each read scope maps
 * to a family of `/api/v1` read endpoints; `write:tasks` unlocks the task
 * complete/snooze POST routes. `/api/v1/me` (identity only) needs no scope.
 * Keep this list and the per-route guards in `handlers/api/handler.ts` in
 * sync.
 *
 * Read and write scopes are deliberately split: every implicit default
 * (legacy keys with no scopes attribute, creates that omit scopes) expands to
 * READ scopes only. Write access must always be an explicit grant.
 */
export const READ_API_SCOPES = ['read:plants', 'read:tasks', 'read:activity'] as const;
export const WRITE_API_SCOPES = ['write:tasks'] as const;
export const API_SCOPES = ['read:plants', 'read:tasks', 'read:activity', 'write:tasks'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export interface ApiKeyRecord {
  id: string;
  householdId: string;
  /** Friendly label the user picks ("Home Assistant", "personal script"). */
  label: string;
  /** Last 4 chars of the plaintext key, displayed in the UI for identification. */
  last4: string;
  /** Granted read scopes. Defaults to all scopes for keys minted before this
   *  field existed (read in `mapRecord`). */
  scopes: ApiScope[];
  createdAt: string;
  createdBy: string;
  /** ISO timestamp of most-recent successful auth, or null if never used. */
  lastUsedAt: string | null;
}

/**
 * Project a stored DDB item into an `ApiKeyRecord`. Centralizes the
 * backward-compatible scope default so list + lookup can't drift.
 *
 * Legacy rows (no `scopes` attribute, minted before scopes existed) expand to
 * ALL READ scopes — never write scopes. Those keys were issued under a
 * read-only API contract, and silently upgrading them to write access would
 * be a privilege escalation.
 */
function mapRecord(item: Record<string, unknown>): ApiKeyRecord {
  const rawScopes = item.scopes;
  const scopes: ApiScope[] =
    Array.isArray(rawScopes) && rawScopes.length > 0
      ? rawScopes.filter((s): s is ApiScope => typeof s === 'string' && isApiScope(s))
      : [...READ_API_SCOPES];
  return {
    id: item.id as string,
    householdId: item.householdId as string,
    label: item.label as string,
    last4: item.last4 as string,
    scopes,
    createdAt: item.createdAt as string,
    createdBy: item.createdBy as string,
    lastUsedAt: (item.lastUsedAt as string | null) ?? null,
  };
}

export interface ApiKeyCreateResult {
  record: ApiKeyRecord;
  /** Plaintext key, returned ONCE. The user must copy it now. */
  plaintext: string;
}

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function generatePlaintext(): string {
  return `fg_${randomBytes(24).toString('hex')}`;
}

export async function createApiKey(
  householdId: string,
  createdBy: string,
  label: string,
  scopes?: ApiScope[]
): Promise<ApiKeyCreateResult> {
  const id = uuid();
  const plaintext = generatePlaintext();
  const last4 = plaintext.slice(-4);
  const now = new Date().toISOString();
  // No scopes requested → grant the full READ surface (matches pre-scopes
  // behavior and keeps the simple "just give me a key" path one click).
  // Write scopes are never granted implicitly.
  const grantedScopes = scopes && scopes.length > 0 ? scopes : [...READ_API_SCOPES];
  const record: ApiKeyRecord = {
    id,
    householdId,
    label,
    last4,
    scopes: grantedScopes,
    createdAt: now,
    createdBy,
    lastUsedAt: null,
  };
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `APIKEY#${id}`,
        GSI3PK: `APIKEY_HASH#${hashKey(plaintext)}`,
        GSI3SK: `HOUSEHOLD#${householdId}`,
        entityType: 'ApiKey',
        ...record,
      },
    })
  );
  return { record, plaintext };
}

export async function listApiKeys(householdId: string): Promise<ApiKeyRecord[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'APIKEY#',
      },
      Limit: 50,
    })
  );
  return (result.Items ?? []).map(mapRecord);
}

/**
 * Delete a key row. Returns `true` when a key was actually deleted, `false`
 * when no such key existed (caller maps that to a 404 per API conventions).
 */
export async function revokeApiKey(householdId: string, keyId: string): Promise<boolean> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `APIKEY#${keyId}` },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

/**
 * Look up a key by its plaintext value. Returns the record (so the caller
 * can scope downstream queries to its household) or null when the key is
 * unknown or revoked.
 *
 * On a successful lookup we update `lastUsedAt` async — failures here don't
 * fail the request, just leave a stale timestamp.
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyRecord | null> {
  if (!plaintext.startsWith('fg_')) return null;
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `APIKEY_HASH#${hashKey(plaintext)}`,
      },
      Limit: 1,
    })
  );
  const item = result.Items?.[0];
  if (!item) return null;

  // lastUsedAt bump. Awaited — a fire-and-forget promise races the Lambda
  // freeze after the response is returned and silently never lands.
  // Conditioned on attribute_exists so a key revoked between the GSI read
  // and this write can't be resurrected as a bare {PK, SK, lastUsedAt} row.
  const now = new Date().toISOString();
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK as string, SK: item.SK as string },
        UpdateExpression: 'SET lastUsedAt = :now',
        ExpressionAttributeValues: { ':now': now },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      // Key was revoked concurrently — don't recreate it, and don't honor it.
      return null;
    }
    // Telemetry only — the lookup itself already succeeded. We still want
    // the failure to surface in CloudWatch so it's not invisible if DDB
    // starts throttling writes.
    logger.warn({ err }, 'api_key_last_used_update_failed');
  }

  return mapRecord(item);
}

// Exported for tests only.
export const _internal = { hashKey, generatePlaintext };
