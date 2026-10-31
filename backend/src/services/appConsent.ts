import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { invalidateMembership } from '../utils/membershipCache.js';
import { APP_STORE_APP_APPLE_ID, APP_STORE_BUNDLE_ID } from '../config/appStore.js';
import { verifyAppleJws, AppStoreVerificationError, type VerifyOptions } from './appStoreJws.js';
import { getMembershipsByUser } from './householdService.js';

/**
 * A parent's withdrawn consent for a minor's use of the iPhone app
 * (app-store age-assurance laws: Texas SB 2420, Utah 13-76, Louisiana
 * R.S. 51:1771, Alabama HB 161; Apple's `RESCIND_CONSENT` notification).
 *
 * Apple blocks the app from launching on the child's device by itself. This
 * module is the server's half: the account that app was signed in to stops
 * working everywhere, the website included, because the Terms cannot be
 * enforced against a minor whose parent has not consented.
 *
 * Linking a notification to an account. `RESCIND_CONSENT` names no account,
 * only the App Store download, through its signed app transaction
 * (`appTransactionId`). So the iPhone app registers its own signed app
 * transaction with the server (`POST /me/app-transaction`), and only when
 * the age signal Apple gave it says the person is a minor: an adult's or an
 * unknown person's app transaction is never sent. The row is a pointer from
 * that app transaction to the account, nothing else.
 *
 * What a withdrawal does:
 *   - a `USER#<id> / APP_CONSENT` row records it, which refuses creating or
 *     joining a household;
 *   - every membership row of the account gets `appConsentRevokedAt`, which
 *     `authMiddleware` treats as no membership (within the 60s cache TTL in
 *     other containers), so the account's tokens reach nothing.
 *
 * Restoring access is a support action (docs/runbooks.md): Apple sends no
 * notification when consent is given again, and a replayed old signed
 * transaction must not be able to undo a withdrawal.
 */

export class AppConsentError extends Error {}

// The link lives in the account's own partition, so deleting the account
// (accountCleanup.deleteUserScopedData sweeps USER#<id>) deletes it too.
// GSI1 finds the accounts for an app transaction.
const appTxnKey = (appTransactionId: string, userId: string) => ({
  PK: `USER#${userId}`,
  SK: `APP_TXN#${appTransactionId}`,
});
const consentKey = (userId: string) => ({ PK: `USER#${userId}`, SK: 'APP_CONSENT' });

const APP_TXN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface AppTransactionPayload {
  bundleId?: unknown;
  appTransactionId?: unknown;
  receiptType?: unknown;
}

/** Verify Apple's signed app transaction and return its `appTransactionId`. */
export function appTransactionIdFrom(
  signedAppTransaction: string,
  options?: VerifyOptions
): string {
  const payload = verifyAppleJws<AppTransactionPayload>(signedAppTransaction, options);
  if (payload.bundleId !== APP_STORE_BUNDLE_ID) {
    throw new AppConsentError('app transaction is for another app');
  }
  const id = payload.appTransactionId;
  if (typeof id !== 'string' || !APP_TXN_ID_RE.test(id)) {
    throw new AppConsentError('app transaction has no appTransactionId');
  }
  return id;
}

/**
 * Record that the signed-in account uses the app download named by
 * `signedAppTransaction`. Idempotent. Throws `AppStoreVerificationError` or
 * `AppConsentError` for anything that is not this app's Apple-signed data.
 */
export async function registerAppTransaction(
  userId: string,
  signedAppTransaction: string,
  options?: VerifyOptions,
  now: Date = new Date()
): Promise<void> {
  const appTransactionId = appTransactionIdFrom(signedAppTransaction, options);
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...appTxnKey(appTransactionId, userId),
        GSI1PK: `APP_TXN#${appTransactionId}`,
        GSI1SK: `USER#${userId}`,
        entityType: 'AppTransactionLink',
        userId,
        createdAt: now.toISOString(),
      },
    })
  );
}

/** Whether a parent has withdrawn consent for this account. */
export async function isAppConsentRevoked(userId: string): Promise<boolean> {
  const row = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: consentKey(userId) })
  );
  return typeof row?.Item?.revokedAt === 'string';
}

async function usersForAppTransaction(appTransactionId: string): Promise<string[]> {
  const users: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP_TXN#${appTransactionId}`, ':sk': 'USER#' },
        ExclusiveStartKey: start,
      })
    );
    for (const item of page.Items ?? []) {
      if (typeof item.userId === 'string') users.push(item.userId);
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return users;
}

/** Withdraw the account's access: the consent row plus every membership row. */
export async function revokeAppConsent(userId: string, now: Date = new Date()): Promise<void> {
  const revokedAt = now.toISOString();
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...consentKey(userId), entityType: 'AppConsentRevocation', userId, revokedAt },
    })
  );
  const memberships = await getMembershipsByUser(userId);
  await Promise.all(
    memberships.map((m) =>
      dynamodb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `HOUSEHOLD#${m.householdId}`, SK: `MEMBER#${userId}` },
          UpdateExpression: 'SET appConsentRevokedAt = :r',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':r': revokedAt },
        })
      )
    )
  );
  invalidateMembership(userId);
}

/** Support's undo (docs/runbooks.md): clears the consent row and the membership marks. */
export async function restoreAppConsent(userId: string): Promise<void> {
  await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: consentKey(userId) }));
  const memberships = await getMembershipsByUser(userId);
  await Promise.all(
    memberships.map((m) =>
      dynamodb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `HOUSEHOLD#${m.householdId}`, SK: `MEMBER#${userId}` },
          UpdateExpression: 'REMOVE appConsentRevokedAt',
          ConditionExpression: 'attribute_exists(PK)',
        })
      )
    )
  );
  invalidateMembership(userId);
}

export type RescindOutcome = 'revoked' | 'unmatched' | 'wrong_app';

export interface RescindAppData {
  bundleId?: string;
  appAppleId?: number;
  environment?: string;
  signedAppTransactionInfo?: string;
}

/**
 * Apply a verified `RESCIND_CONSENT` notification's `appData`. Returns how
 * many accounts it reached; `unmatched` (no account registered that app
 * transaction, the usual case for a child who never signed in) is still a
 * handled notification.
 */
export async function applyRescindConsent(
  appData: RescindAppData | undefined,
  options?: VerifyOptions,
  now: Date = new Date()
): Promise<{ outcome: RescindOutcome; accounts: number }> {
  if (!appData || appData.bundleId !== APP_STORE_BUNDLE_ID) {
    return { outcome: 'wrong_app', accounts: 0 };
  }
  if (
    appData.environment === 'Production' &&
    typeof appData.appAppleId === 'number' &&
    appData.appAppleId !== APP_STORE_APP_APPLE_ID
  ) {
    return { outcome: 'wrong_app', accounts: 0 };
  }
  if (!appData.signedAppTransactionInfo) {
    throw new AppStoreVerificationError('RESCIND_CONSENT without signedAppTransactionInfo');
  }
  let appTransactionId: string;
  try {
    appTransactionId = appTransactionIdFrom(appData.signedAppTransactionInfo, options);
  } catch (err) {
    if (err instanceof AppConsentError) return { outcome: 'wrong_app', accounts: 0 };
    throw err;
  }
  const users = await usersForAppTransaction(appTransactionId);
  for (const userId of users) await revokeAppConsent(userId, now);
  // Identity only, never the app transaction id (it names an Apple download).
  logger.info({ accounts: users.length }, 'app_consent_rescinded');
  return { outcome: users.length ? 'revoked' : 'unmatched', accounts: users.length };
}
