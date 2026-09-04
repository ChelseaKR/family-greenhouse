/**
 * One-time welcome email, sent when a brand-new user finishes setup by
 * creating their very first household.
 *
 * Goes straight through `emailNotifier.sendEmail` — it's a single
 * transactional onboarding touch, not a real-time ping, so it skips the
 * `notifier.sendToUser` channel fan-out and the DND window. It is also the
 * first adopter of the shared email kit (`services/email/`), which is why it
 * is short: the layout, the escaping, the plain-text twin and the footer all
 * come from `renderEmail`, and this file only chooses the words.
 *
 * No `List-Unsubscribe`: this is transactional mail sent once, at the moment
 * a person asks for an account, and there is nothing recurring to opt out of.
 * The recurring mail (digest, recap, pest alerts) carries the header.
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
import { t, type EmailLocale } from './email/catalog.js';
import { renderEmail, type EmailBlock } from './email/template.js';
import { settingsUrl } from './email/links.js';
import { resolveEmailLocaleForUser } from './email/locale.js';

const WELCOME_MARKER_SK = 'WELCOME#FIRST_HOUSEHOLD';
const DELIVERY_LEASE_SECONDS = 5 * 60;

/**
 * Compose the welcome email. Pure + exported so the copy can be asserted
 * without reaching SES. `appUrl` is the FRONTEND_URL base (no trailing
 * slash); links hang off it.
 *
 * Note there is no hard wrapping. The old version broke its prose at ~72
 * characters, which reads as ragged short lines on a phone; one logical line
 * per paragraph lets the client wrap to its own width.
 */
export function composeWelcomeEmail(
  userName: string,
  appUrl: string,
  locale: EmailLocale = 'en'
): { subject: string; text: string; html: string } {
  const base = appUrl.replace(/\/+$/, '');
  const trimmed = userName.trim();
  const blocks: EmailBlock[] = [
    {
      kind: 'text',
      text: trimmed
        ? t(locale, 'welcome.greeting', { name: trimmed })
        : t(locale, 'welcome.greetingGeneric'),
    },
    { kind: 'text', text: t(locale, 'welcome.intro') },
    { kind: 'text', text: t(locale, 'welcome.firstStep') },
    { kind: 'button', label: t(locale, 'welcome.cta'), href: `${base}/plants/new` },
    { kind: 'heading', text: t(locale, 'welcome.tipsHeading') },
    { kind: 'text', text: t(locale, 'welcome.tip1'), tone: 'muted' },
    { kind: 'text', text: t(locale, 'welcome.tip2'), tone: 'muted' },
    { kind: 'divider' },
    { kind: 'text', text: t(locale, 'welcome.guides') },
    { kind: 'button', label: t(locale, 'welcome.guidesCta'), href: `${base}/care` },
    { kind: 'text', text: t(locale, 'welcome.signoff'), tone: 'muted' },
  ];
  const { html, text } = renderEmail({
    locale,
    title: t(locale, 'welcome.title'),
    preheader: t(locale, 'welcome.preheader'),
    blocks,
    footer: {
      reason: t(locale, 'footer.reason.welcome'),
      safety: t(locale, 'footer.safety'),
      links: [{ label: t(locale, 'footer.manage'), href: settingsUrl() }],
    },
  });
  return { subject: t(locale, 'welcome.subject'), text, html };
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

  // Resolved OUTSIDE the delivery try/catch. `resolveEmailLocaleForUser`
  // handles its own read failure and reports `source: 'unavailable'`, so a
  // locale problem can never be silently collapsed into "the send failed".
  // The recipient has no preferences row yet at first-household time, so this
  // is `source: 'default'` for almost everyone; logging the source keeps that
  // visible rather than making English look chosen.
  const { locale, source } = await resolveEmailLocaleForUser(userId);
  logger.info(
    { userId, locale, localeSource: source, msg: 'welcome_email_locale' },
    'welcome_email_locale'
  );

  let delivered = false;
  try {
    const { subject, text, html } = composeWelcomeEmail(userName, appUrl, locale);
    delivered = await emailNotifier.sendEmail({ to: email, subject, text, html });
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
