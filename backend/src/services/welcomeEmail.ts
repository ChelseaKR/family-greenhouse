/**
 * One-time welcome email, sent when a brand-new user finishes setup by
 * creating their very first household.
 *
 * Like the digest/recap emails this is plain text (emailNotifier ships no HTML
 * yet) and goes straight through `emailNotifier.sendEmail` — it's a single
 * transactional onboarding touch, not a real-time ping, so it skips the
 * `notifier.sendToUser` channel fan-out and the DND window.
 *
 * A per-user delivery marker makes retries and overlapping first-household
 * requests safe. Failed/dry-run sends release their short lease so a later
 * retry can still deliver; a confirmed SES send is retained for the lifetime
 * of the user.
 */
import { randomUUID } from 'node:crypto';
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '../utils/logger.js';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import * as emailNotifier from './emailNotifier.js';

const WELCOME_MARKER_SK = 'WELCOME#FIRST_HOUSEHOLD';
const DELIVERY_LEASE_SECONDS = 5 * 60;

/** Compose the plain-text welcome email. Pure + exported so it's unit-testable
 *  and the copy can be asserted without reaching SES. `appUrl` is the
 *  FRONTEND_URL base (no trailing slash); links hang off it. */
export function composeWelcomeEmail(
  userName: string,
  appUrl: string
): { subject: string; text: string } {
  const base = appUrl.replace(/\/+$/, '');
  // A genuine first name when we have one, otherwise a warm generic greeting.
  const greeting = userName.trim() ? `Hi ${userName.trim()},` : 'Hi there,';
  const subject = 'Welcome to Family Greenhouse 🌱';
  const text = [
    greeting,
    '',
    "You're all set up — welcome to Family Greenhouse. We're glad you're here.",
    '',
    'The best first step is to add your first plant. It takes less than a',
    'minute: give it a name, or start from a species suggestion and we’ll fill',
    'in the care details for you.',
    '',
    `Add your first plant: ${base}/plants/new`,
    '',
    'A couple of small tips to get started:',
    '  - Most houseplants would rather be a little too dry than too wet — when',
    '    in doubt, wait a day and check the soil with your finger.',
    '  - Bright, indirect light suits the widest range of plants. A spot near a',
    '    window that never gets harsh midday sun is a safe bet.',
    '',
    `Not sure where to begin? Our care guides cover the popular plants: ${base}/care`,
    '',
    'Happy growing,',
    'The Family Greenhouse team',
  ].join('\n');
  return { subject, text };
}

/**
 * Send the welcome email to a newly-onboarded user. Best-effort: any failure
 * is logged and swallowed so it can never break the household-creation flow.
 * Returns true only when SES accepted a real send. A dry-run when SES is
 * unconfigured returns false, matching every other notification dispatcher.
 */
export async function sendWelcomeEmail(
  userId: string,
  email: string,
  userName: string,
  appUrl: string
): Promise<boolean> {
  const reservationId = randomUUID();
  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: WELCOME_MARKER_SK,
          entityType: 'WelcomeEmailMarker',
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + DELIVERY_LEASE_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :sending AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':sending': 'sending', ':now': nowEpoch },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    logger.warn(
      { err: (err as Error).message, userId, msg: 'welcome_email_reservation_failed' },
      'welcome_email_reservation_failed'
    );
    return false;
  }

  let delivered = false;
  try {
    const { subject, text } = composeWelcomeEmail(userName, appUrl);
    delivered = await emailNotifier.sendEmail({ to: email, subject, text });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId, msg: 'welcome_email_failed' },
      'welcome_email_failed'
    );
  }

  if (!delivered) {
    await releaseWelcomeSlot(userId, reservationId).catch((cleanupErr) => {
      logger.warn(
        { err: (cleanupErr as Error).message, userId, msg: 'welcome_email_release_failed' },
        'welcome_email_release_failed'
      );
    });
    return false;
  }

  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: WELCOME_MARKER_SK },
        UpdateExpression:
          'SET #status = :sent, sentAt = :sentAt REMOVE leaseExpiresAt, reservationId',
        ConditionExpression: '#status = :sending AND reservationId = :reservationId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':sent': 'sent',
          ':sending': 'sending',
          ':sentAt': now.toISOString(),
          ':reservationId': reservationId,
        },
      })
    );
  } catch (err) {
    // SES already accepted the message. Never delete/reopen the lease here:
    // doing so would guarantee a duplicate on the next onboarding retry.
    // The short lease still makes a crashed pre-send attempt recoverable.
    logger.warn(
      { err: (err as Error).message, userId, msg: 'welcome_email_finalize_failed' },
      'welcome_email_finalize_failed'
    );
  }
  return true;
}

async function releaseWelcomeSlot(userId: string, reservationId: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: WELCOME_MARKER_SK },
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}
