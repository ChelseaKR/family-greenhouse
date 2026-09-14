/**
 * The sign-up row the confirm-reminder pass reads (services/confirmReminders.ts).
 *
 * One row per self-service sign-up, written by `POST /auth/signup` right after
 * Cognito accepts the account:
 *
 *   PK = SIGNUP_CONFIRM_REMINDER, SK = SIGNUP#<ISO sign-up time>#<Cognito sub>
 *
 * A single partition sorted by time is what lets the hourly pass read "sign-ups
 * between 24 hours and 7 days old" with one Query, instead of listing the user
 * pool (which would also need `cognito-idp:ListUsers` on a role every API
 * handler shares). The row carries the opaque Cognito `sub` and nothing else
 * about the person: no email, no name.
 *
 * This lives apart from the reminder pass on purpose. The auth Lambda imports
 * it, and the pass pulls in the SES v2 client and the suppression service. The
 * auth function's cold start is already its slowest path (p95 about 2 s in the
 * 2026-09-13 funnel measurement), and writing this row needs DynamoDB only.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

export const SIGNUP_PARTITION = 'SIGNUP_CONFIRM_REMINDER';
export const SIGNUP_SORT_PREFIX = 'SIGNUP#';

/**
 * How long a sign-up row lives. It must outlive the reminder window (7 days)
 * by a wide margin. Expiry can never cause a second send: once a row is gone
 * the account has no row and cannot be selected at all. It only ends the
 * "confirmed after a reminder" follow-up for that account.
 */
export const ROW_TTL_SECONDS = 30 * 24 * 60 * 60;

export function signupSortKey(signedUpAt: string, userSub: string): string {
  return `${SIGNUP_SORT_PREFIX}${signedUpAt}#${userSub}`;
}

/**
 * Record a sign-up so the reminder pass can find it.
 *
 * NEVER throws. The account already exists in Cognito when this runs, so a
 * failure here must not turn a successful sign-up into an error. It only means
 * that account gets no reminder, which is the safe direction. Returns whether
 * the row was written. The log lines carry no identifier.
 */
export async function recordSignup(userSub: string, now: Date = new Date()): Promise<boolean> {
  if (!userSub) {
    logger.warn(
      { msg: 'confirm_reminders.signup_record_skipped', reason: 'no_cognito_sub' },
      'confirm_reminders.signup_record_skipped'
    );
    return false;
  }
  const signedUpAt = now.toISOString();
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: SIGNUP_PARTITION,
          SK: signupSortKey(signedUpAt, userSub),
          entityType: 'SignupConfirmReminder',
          userSub,
          signedUpAt,
          ttl: Math.floor(now.getTime() / 1000) + ROW_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    logger.warn(
      { msg: 'confirm_reminders.signup_record_failed', errorName: (err as Error).name },
      'confirm_reminders.signup_record_failed'
    );
    return false;
  }
}
