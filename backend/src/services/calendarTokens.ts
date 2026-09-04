/**
 * Calendar-feed tokens: the credential behind the subscribe-able `.ics` URL
 * that Settings hands out.
 *
 * Why a secret in the URL at all: calendar apps (Apple Calendar, Google
 * Calendar, Outlook, Thunderbird) fetch a subscription URL on their own
 * schedule with no interactive login and no way to attach a Cognito session.
 * The route `GET /me/calendar.ics` sits behind the API Gateway JWT authorizer,
 * so every fetch from a calendar app was rejected with 401 before the Lambda
 * ran. The only pattern that works for third-party subscription clients is a
 * capability URL — and the tradeoff that name implies is real: whoever holds
 * the link can read the calendar. Everything below keeps that blast radius
 * small:
 *
 *   - Scope. One (user, household) pair, READ-ONLY, and only what
 *     `icsExport.buildIcs` emits (task titles, cadence, due dates). It is NOT
 *     an API key: it opens nothing under `/api/v1` or any authenticated route,
 *     and the two credentials live in separate hash namespaces (different
 *     fixed salts, different key prefixes) so one can never be presented as
 *     the other.
 *   - Entropy. 32 bytes from the OS CSPRNG, hex-encoded (256 bits) — the same
 *     budget as sitter links and above the 192-bit API keys.
 *   - At rest. Hashed with scryptSync + a fixed application salt, the
 *     deterministic lookup-by-hash pattern `apiKeys.ts` documents (a random
 *     per-row salt would make lookup impossible; a static salt is fine because
 *     the input is a 256-bit CSPRNG value, not a human-chosen password). The
 *     plaintext is returned exactly once, at mint, and cannot be re-shown —
 *     "regenerate" is the recovery path, exactly like a lost API key.
 *   - Revocable + regenerable from Settings. Regenerate overwrites the row,
 *     so the previous URL dies with it.
 *   - Membership is re-checked by the handler on every fetch, so leaving (or
 *     being removed from) the household kills the feed even while the token
 *     row still exists.
 *
 * Storage (single table):
 *   PK: USER#{userId}                        SK: CALTOKEN#{householdId}
 *   GSI1PK: CALTOKEN_HASH#{scrypt(token)}    GSI1SK: USER#{userId}
 *
 * The base row lives in the user's own partition so `accountCleanup.
 * deleteUserScopedData`'s generic partition sweep erases it with the rest of
 * the account, and so status / regenerate / revoke are single point
 * reads/writes keyed on the caller's identity. The GSI1 projection gives the
 * public feed one query per fetch (GSI1 is one of the two indexes the table
 * Terraform defines); the lookup then re-verifies the hash against the base
 * row in the same conditional write that bumps `lastUsedAt`, so an
 * eventually-consistent index read can never honour a URL that was regenerated
 * or revoked a moment earlier.
 */
import { scryptSync, randomBytes } from 'node:crypto';
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

export interface CalendarTokenRecord {
  userId: string;
  householdId: string;
  createdAt: string;
  /** ISO timestamp of the most recent successful feed fetch, or null if never. */
  lastUsedAt: string | null;
}

export interface CalendarTokenCreateResult {
  record: CalendarTokenRecord;
  /** Plaintext token, returned ONCE. The user must copy the URL now. */
  token: string;
}

/** 64 lowercase hex chars — the only shape a token of ours can have. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The public feed path for a token. The backend owns this so the frontend
 * and the OpenAPI spec cannot drift from the route the Lambda actually
 * serves; POST /me/calendar-token returns it alongside the token.
 */
export function calendarFeedPath(token: string): string {
  return `/calendar/${token}/family-greenhouse.ics`;
}

/**
 * Deterministic, memory-hard hash for the GSI1 lookup key. Same construction
 * and same reasoning as `apiKeys.hashKey`; a DIFFERENT fixed salt so calendar
 * tokens and API keys can never collide in the index even if someone pastes
 * one where the other is expected.
 */
function hashToken(token: string): string {
  return scryptSync(token, 'family-greenhouse-caltoken-v1', 32).toString('hex');
}

function generateToken(): string {
  // randomBytes draws from the OS CSPRNG; do NOT swap for uuid()/Math.random.
  return randomBytes(32).toString('hex');
}

function keyFor(userId: string, householdId: string): { PK: string; SK: string } {
  return { PK: `USER#${userId}`, SK: `CALTOKEN#${householdId}` };
}

function mapRecord(item: Record<string, unknown>): CalendarTokenRecord {
  return {
    userId: item.userId as string,
    householdId: item.householdId as string,
    createdAt: item.createdAt as string,
    lastUsedAt: (item.lastUsedAt as string | null) ?? null,
  };
}

/**
 * Mint a token for (user, household). Overwrites any existing token for the
 * pair — this IS the regenerate operation — so the old URL stops resolving as
 * soon as the write lands (its hash is no longer on any row).
 */
export async function createCalendarToken(
  userId: string,
  householdId: string
): Promise<CalendarTokenCreateResult> {
  const token = generateToken();
  const now = new Date().toISOString();
  const record: CalendarTokenRecord = { userId, householdId, createdAt: now, lastUsedAt: null };
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...keyFor(userId, householdId),
        GSI1PK: `CALTOKEN_HASH#${hashToken(token)}`,
        GSI1SK: `USER#${userId}`,
        entityType: 'CalendarToken',
        ...record,
      },
    })
  );
  return { record, token };
}

/** The non-secret status of the caller's token for a household, or null. */
export async function getCalendarToken(
  userId: string,
  householdId: string
): Promise<CalendarTokenRecord | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: keyFor(userId, householdId) })
  );
  return result.Item ? mapRecord(result.Item) : null;
}

/**
 * Delete the token row. Returns `true` when a token was actually revoked,
 * `false` when none existed (caller maps that to a 404 per API conventions).
 */
export async function revokeCalendarToken(userId: string, householdId: string): Promise<boolean> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: keyFor(userId, householdId),
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
 * Resolve a presented token to its (user, household) grant, or null when it is
 * malformed, unknown, revoked, or has been regenerated. Every miss is the same
 * null so the public endpoint can't be used as a token-existence oracle.
 *
 * The `lastUsedAt` bump doubles as the freshness check: it is conditioned on
 * the base row still carrying THIS token's hash, so a stale GSI1 read after a
 * regenerate/revoke is refused rather than honoured. Awaited (not
 * fire-and-forget) for the same reason as `apiKeys.lookupApiKey` — a dangling
 * promise races the Lambda freeze and silently never lands.
 */
export async function resolveCalendarToken(token: string): Promise<CalendarTokenRecord | null> {
  // Charset/length gate: a token that can't be ours never hits DynamoDB.
  if (!TOKEN_SHAPE.test(token)) return null;
  const hash = `CALTOKEN_HASH#${hashToken(token)}`;
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': hash },
      Limit: 1,
    })
  );
  const item = result.Items?.[0];
  if (!item) return null;

  const now = new Date().toISOString();
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK as string, SK: item.SK as string },
        UpdateExpression: 'SET lastUsedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND #hash = :hash',
        ExpressionAttributeNames: { '#hash': 'GSI1PK' },
        ExpressionAttributeValues: { ':now': now, ':hash': hash },
      })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      // Revoked or regenerated between the index read and this write — the
      // index was stale. Don't honour it, and don't resurrect the row.
      return null;
    }
    // Telemetry only — the lookup itself already succeeded; a throttled
    // timestamp write must not take the feed down. Nothing about the token
    // is logged, only the failure.
    logger.warn({ err }, 'calendar_token_last_used_update_failed');
  }

  return mapRecord(item);
}

// Exported for tests only.
export const _internal = { hashToken, generateToken, TOKEN_SHAPE };
