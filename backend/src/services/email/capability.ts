/**
 * Revocable capability tokens for email links that must work with no session.
 *
 * RFC 8058 one-click unsubscribe requires a URL a mail provider can POST to
 * on the recipient's behalf, without a login and without a confirmation
 * screen. Gmail and Yahoo's bulk-sender rules make it effectively mandatory
 * for non-transactional mail, and it is the single largest deliverability win
 * available to this product today.
 *
 * ## Shape
 *
 * The token codec lives in `capabilityToken.ts` — pure, no DynamoDB — so the
 * dev server can mirror this flow without dragging `utils/dynamodb.ts` and its
 * module-scope `requireEnv('TABLE_NAME')` into its import graph (see
 * `tests/integration/local-server-boot.test.ts`). This file owns the stored
 * per-user secret those tokens are signed with.
 *
 * ## Why a per-user secret rather than one service secret
 *
 * Revocation. A single service key can only be rotated for everybody at once;
 * a per-user secret means "revoke my links" is one write to one row. It also
 * needs no new environment variable, no Terraform change and no secret to
 * manage — which matters because the digests Lambda's environment is
 * deliberately minimal (`local.email_environment`).
 *
 * ## Why its own row rather than an attribute on PREFS
 *
 * `USER#{id} / PREFS` is read by `notificationPrefs.getPreferences`, which
 * treats a present row as authoritative and coerces missing attributes with
 * `Boolean(item.email)`. An upsert that created that row just to hold a
 * secret would therefore hand a user a preferences record with **email off**
 * — silently unsubscribing them from everything. The secret lives on
 * `USER#{id} / EMAILCAP` so no capability write can ever touch delivery
 * preferences.
 *
 * ## What a token can and cannot do
 *
 * A capability token can turn ONE email category off for ONE user. It cannot
 * read anything, cannot turn a category back on, and cannot reach any other
 * endpoint. Losing one is equivalent to someone unsubscribing you from the
 * weekly digest — annoying, recoverable in the app, and not an account
 * compromise. That bounded blast radius is what makes a no-login link
 * acceptable at all.
 */
import { randomBytes } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import { logger } from '../../utils/logger.js';
import {
  parseToken,
  signToken,
  verifyTokenWithSecret,
  type EmailCategory,
  type VerifyResult,
} from './capabilityToken.js';

export {
  EMAIL_CATEGORIES,
  isEmailCategory,
  parseToken,
  signToken,
  verifyTokenWithSecret,
} from './capabilityToken.js';
export type { EmailCategory, VerifyResult } from './capabilityToken.js';

/** Tokens outlive the email that carried them by a wide margin, because a
 *  message can sit unread for months, but not forever. */
const TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;
const CAPABILITY_SK = 'EMAILCAP';

function key(userId: string) {
  return { PK: `USER#${userId}`, SK: CAPABILITY_SK };
}

export type SecretResult =
  | { status: 'ok'; secret: string }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: string };

/**
 * Read (or lazily create) this user's capability secret.
 *
 * `if_not_exists` makes creation idempotent under concurrency: two digest
 * passes racing on the same user both end up with the same secret rather than
 * one silently invalidating the other's freshly-minted links. Failure returns
 * a NAMED unavailable state, never an empty string — an empty key would
 * produce tokens that verify against nothing.
 */
export async function getOrCreateSecret(userId: string): Promise<SecretResult> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key(userId),
        UpdateExpression: 'SET #secret = if_not_exists(#secret, :fresh), entityType = :entityType',
        ExpressionAttributeNames: { '#secret': 'secret' },
        ExpressionAttributeValues: {
          ':fresh': randomBytes(32).toString('base64url'),
          ':entityType': 'EmailCapabilitySecret',
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    const secret: unknown = result.Attributes?.secret;
    if (typeof secret !== 'string' || secret.length === 0) {
      return { status: 'unavailable', reason: 'no_secret_returned' };
    }
    return { status: 'ok', secret };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId, msg: 'email_capability.secret_write_failed' },
      'email_capability.secret_write_failed'
    );
    return { status: 'unavailable', reason: 'write_failed' };
  }
}

/**
 * Read the secret without creating one. Verification must never mint a row
 * for an arbitrary user id from an unauthenticated request — an absent row
 * means no token was ever issued, which is `missing`, not a fresh secret.
 */
export async function readSecret(userId: string): Promise<SecretResult> {
  try {
    const result = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: key(userId) }));
    const secret: unknown = result.Item?.secret;
    if (typeof secret !== 'string' || secret.length === 0) return { status: 'missing' };
    return { status: 'ok', secret };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId, msg: 'email_capability.secret_read_failed' },
      'email_capability.secret_read_failed'
    );
    return { status: 'unavailable', reason: 'read_failed' };
  }
}

/** Invalidate every outstanding capability URL for this user. */
export async function revokeCapabilities(userId: string): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key(userId),
      UpdateExpression: 'SET #secret = :fresh, entityType = :entityType',
      ExpressionAttributeNames: { '#secret': 'secret' },
      ExpressionAttributeValues: {
        ':fresh': randomBytes(32).toString('base64url'),
        ':entityType': 'EmailCapabilitySecret',
      },
    })
  );
}

export type MintResult =
  { status: 'ok'; token: string } | { status: 'unavailable'; reason: string };

export async function mintUnsubscribeToken(
  userId: string,
  category: EmailCategory,
  now: Date = new Date()
): Promise<MintResult> {
  const secret = await getOrCreateSecret(userId);
  if (secret.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: secret.status === 'missing' ? 'missing' : secret.reason,
    };
  }
  const expiresAt = Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS;
  return { status: 'ok', token: signToken(secret.secret, userId, category, expiresAt) };
}

/**
 * Verify a capability token against this user's stored secret.
 *
 * The four outcomes are distinct on purpose. `invalid` and `expired` are
 * answers about the token; `unavailable` means we could not look up the
 * secret and therefore do not know — the handler returns 503 rather than
 * telling the recipient their unsubscribe link is bad, which is exactly the
 * "absence rendered as a value" failure this repo gates against.
 */
export async function verifyUnsubscribeToken(
  token: string,
  now: Date = new Date()
): Promise<VerifyResult> {
  const parsed = parseToken(token);
  if (!parsed) return { status: 'invalid' };

  const secret = await readSecret(parsed.userId);
  if (secret.status === 'unavailable') return { status: 'unavailable' };
  if (secret.status === 'missing') return { status: 'invalid' };

  return verifyTokenWithSecret(token, secret.secret, now);
}
