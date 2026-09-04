/**
 * Delivery for the money-lifecycle emails: receipt, renewal notice, payment
 * failure, card expiring, cancellation, and the account-deletion
 * confirmation. See [ADR 0023](../../../docs/adr/0023-billing-lifecycle-emails.md).
 *
 * The split across three files is deliberate:
 *   - `models/billingNotices.ts` decides WHAT a Stripe event means and which
 *     facts it actually carried (pure).
 *   - `services/billingEmailCopy.ts` decides what to SAY, in en and es (pure).
 *   - this file decides WHO gets it, exactly once, and puts it on SES.
 *
 * ## Transactional, and therefore ungated
 *
 * Every notice here concerns money already taken, money about to be taken, or
 * access about to end. None of them is gated on `notificationPrefs.email`,
 * `weeklyDigest`, or the do-not-disturb window, and none carries a marketing
 * unsubscribe. `notificationPrefs` is read for exactly one field — `timezone`
 * — so a renewal date renders in the zone the account already uses for quiet
 * hours. Nothing on that row decides whether the email sends.
 *
 * Sending goes through `emailNotifier.sendEmail` unchanged, so whatever
 * deliverability wiring lands there (a configuration set, bounce/complaint
 * suppression) applies to these the moment it exists. Nothing here reaches
 * SES directly.
 *
 * ## Exactly once
 *
 * Redelivery is normal: Stripe guarantees at-least-once and no ordering. Each
 * send takes a marker in the EXISTING Stripe-event ledger partition,
 * `PK: STRIPE_EVENT#{eventId}`, under its own sort key
 * `EMAIL#{kind}#{userId}`.
 *
 * The separate sort key is required, not cosmetic. The ledger's `METADATA` row
 * is written AFTER the subscription apply precisely so a failed apply can be
 * retried (see `billing.recordStripeEventOnce`); claiming that same row before
 * sending an email would make a failed apply permanently un-retryable. Keying
 * per recipient additionally means one admin's failed send never re-mails the
 * admin whose send succeeded.
 *
 * The claim/send/finalize lease is the same shape `welcomeEmail` uses: a
 * failed or dry-run send releases its slot so a redelivery can still deliver,
 * and a confirmed SES send never reopens it — reopening would guarantee a
 * duplicate receipt on the next redelivery, and a duplicate receipt is the
 * one outcome that makes a customer doubt the charge itself.
 */
import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type Stripe from 'stripe';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { firstAllowedOrigin } from '../middleware/cors.js';
import {
  billingNoticeForEvent,
  type BillingNotice,
  type BillingNoticePhase,
} from '../models/billingNotices.js';
import { getPlan, type Plan } from '../models/plans.js';
import type { HouseholdMember } from '../models/types.js';
import {
  composeAccountDeletionEmail,
  composeBillingEmail,
  DEFAULT_BILLING_EMAIL_LOCALE,
  type BillingEmailLocale,
} from './billingEmailCopy.js';
import * as emailNotifier from './emailNotifier.js';
import * as householdService from './householdService.js';
import * as notificationPrefs from './notificationPrefs.js';

/** Long enough for a cold start plus an SES call, short enough that a Lambda
 *  killed mid-send frees the slot before Stripe's next retry. */
const EMAIL_LEASE_SECONDS = 5 * 60;
/** Matches the Stripe-event ledger's own TTL, so the whole partition for an
 *  event ages out together. Stripe stops retrying long before this. */
const EMAIL_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * The customer→household pointer is refreshed on every receipt, so a household
 * that is billing at all keeps it alive; 400 days lets a lapsed one age out
 * instead of accumulating forever.
 */
const CUSTOMER_POINTER_TTL_SECONDS = 400 * 24 * 60 * 60;

function eventPartition(eventId: string): string {
  return `STRIPE_EVENT#${eventId}`;
}

function markerSortKey(notice: BillingNotice, userId: string): string {
  return `EMAIL#${notice.kind}#${userId}`;
}

function customerPointerKey(stripeCustomerId: string): { PK: string; SK: string } {
  return { PK: `STRIPE_CUSTOMER#${stripeCustomerId}`, SK: 'METADATA' };
}

// ---------------------------------------------------------------------------
// Household resolution
// ---------------------------------------------------------------------------

/**
 * The household a Stripe customer belongs to.
 *
 * `customer.source.expiring` carries a Card whose only link to us is a
 * customer id, and resolving it through Stripe would mean a live API call from
 * inside the webhook. So every notice that DOES know both ids writes this
 * pointer, and the ones that know only a customer read it.
 *
 * A missing pointer returns null and the email is not sent. That is the
 * intended behaviour: a household we cannot identify gets no mail rather than
 * mail addressed to a guess.
 */
async function readCustomerPointer(stripeCustomerId: string): Promise<string | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: customerPointerKey(stripeCustomerId) })
  );
  const householdId: unknown = result.Item?.householdId;
  return typeof householdId === 'string' && householdId !== '' ? householdId : null;
}

/** Record (or refresh) the customer→household pointer. Best-effort: failing to
 *  remember a pointer must not stop the email that taught it to us. */
async function rememberCustomerPointer(
  householdId: string,
  stripeCustomerId: string | null
): Promise<void> {
  if (stripeCustomerId === null) return;
  const ttl = Math.floor(Date.now() / 1000) + CUSTOMER_POINTER_TTL_SECONDS;
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...customerPointerKey(stripeCustomerId),
          entityType: 'StripeCustomerPointer',
          householdId,
          stripeCustomerId,
          ttl,
        },
      })
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, stripeCustomerId },
      'billing_email_customer_pointer_write_failed'
    );
  }
}

async function resolveHouseholdId(notice: BillingNotice): Promise<string | null> {
  if (notice.householdId !== null) return notice.householdId;
  if (notice.stripeCustomerId === null) return null;
  return readCustomerPointer(notice.stripeCustomerId);
}

/**
 * The tier the household holds right now.
 *
 * Read directly rather than through `billing.getHouseholdSubscription` so this
 * module does not import back into the module that dispatches into it. Only
 * `planId` is wanted, from the same attribute on the same row.
 *
 * A row with no plan on it is a real seedling household, which is what
 * `getPlan(undefined)` returns. A FAILED read never gets here: the send throws
 * and no email goes out, because "your household is now on Seedling" must not
 * be said on the strength of a read that did not happen.
 */
async function readHouseholdPlan(householdId: string): Promise<Plan> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
    })
  );
  return getPlan(result.Item?.planId as string | undefined);
}

/**
 * The recipient's stored IANA timezone.
 *
 * NOT a preference check. This reads one field off the notification-prefs row
 * so dates render in the zone the account already uses for quiet hours;
 * nothing on that row gates a billing email. `getPreferences` returns the
 * documented `UTC` default for a row that was never written and throws when
 * the read itself fails — which is the behaviour we want, since the caller
 * then sends nothing rather than dating an invoice wrongly.
 */
async function recipientTimeZone(userId: string): Promise<string> {
  const prefs = await notificationPrefs.getPreferences(userId);
  return notificationPrefs.isValidTimeZone(prefs.timezone) ? prefs.timezone : 'UTC';
}

function appBaseUrl(): string {
  return process.env.FRONTEND_URL || firstAllowedOrigin() || 'https://familygreenhouse.net';
}

// ---------------------------------------------------------------------------
// The per-recipient exactly-once marker
// ---------------------------------------------------------------------------

async function claimSlot(
  eventId: string,
  sortKey: string,
  reservationId: string
): Promise<boolean> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: eventPartition(eventId),
          SK: sortKey,
          entityType: 'BillingEmailMarker',
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + EMAIL_LEASE_SECONDS,
          ttl: nowEpoch + EMAIL_MARKER_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :sending AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':sending': 'sending', ':now': nowEpoch },
      })
    );
    return true;
  } catch (err) {
    // Already sent, or another delivery of the same event holds the lease.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    // Anything else is an infrastructure failure, not a duplicate. Propagate
    // so the caller logs it rather than silently dropping a receipt.
    throw err;
  }
}

async function releaseSlot(eventId: string, sortKey: string, reservationId: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: eventPartition(eventId), SK: sortKey },
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}

async function finalizeSlot(
  eventId: string,
  sortKey: string,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: eventPartition(eventId), SK: sortKey },
      UpdateExpression:
        'SET #status = :sent, sentAt = :sentAt REMOVE leaseExpiresAt, reservationId',
      ConditionExpression: '#status = :sending AND reservationId = :reservationId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sent': 'sent',
        ':sending': 'sending',
        ':sentAt': new Date().toISOString(),
        ':reservationId': reservationId,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Only the cancellation notices state what plan the household holds. */
function needsCurrentPlan(notice: BillingNotice): boolean {
  return notice.kind === 'cancellation_scheduled' || notice.kind === 'cancellation_complete';
}

interface Recipient {
  userId: string;
  email: string;
}

/**
 * Who hears about money: the household's admins.
 *
 * Only an admin can open checkout or the billing portal
 * (`handlers/billing/handler.ts` puts `requireAdmin` on both), so they are the
 * only people who can act on any of these, and a household's payment details
 * are not everyone's business. Resolved from OUR roster rather than from the
 * address Stripe holds, so a billing email never goes anywhere the household
 * has not put on its own member list.
 */
function adminRecipients(members: HouseholdMember[]): Recipient[] {
  return members
    .filter((m) => m.role === 'admin' && typeof m.email === 'string' && m.email.includes('@'))
    .map((m) => ({ userId: m.userId, email: m.email }));
}

async function sendToRecipient(
  event: Stripe.Event,
  notice: BillingNotice,
  recipient: Recipient,
  currentPlan: Plan | undefined,
  locale: BillingEmailLocale
): Promise<void> {
  const sortKey = markerSortKey(notice, recipient.userId);
  const reservationId = randomUUID();
  const claimed = await claimSlot(event.id, sortKey, reservationId);
  if (!claimed) {
    logger.info(
      { stripeEventId: event.id, type: event.type, kind: notice.kind },
      'billing_email_duplicate_skipped'
    );
    return;
  }

  const timeZone = await recipientTimeZone(recipient.userId);
  let delivered = false;
  try {
    const { subject, text } = composeBillingEmail(notice, {
      locale,
      timeZone,
      appUrl: appBaseUrl(),
      currentPlan,
    });
    delivered = await emailNotifier.sendEmail({ to: recipient.email, subject, text });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, stripeEventId: event.id, kind: notice.kind },
      'billing_email_send_failed'
    );
  }

  if (!delivered) {
    // A dry run (SES unconfigured) and a real failure both land here. Free the
    // slot so a redelivery — or the same event replayed from the Stripe
    // dashboard once SES is wired — can still deliver it.
    await releaseSlot(event.id, sortKey, reservationId).catch((err) => {
      logger.warn(
        { err: (err as Error).message, stripeEventId: event.id, kind: notice.kind },
        'billing_email_release_failed'
      );
    });
    return;
  }

  await finalizeSlot(event.id, sortKey, reservationId).catch((err) => {
    // SES already accepted it. Never delete the marker here: that would
    // guarantee a second receipt on the next redelivery.
    logger.warn(
      { err: (err as Error).message, stripeEventId: event.id, kind: notice.kind },
      'billing_email_finalize_failed'
    );
  });

  logger.info(
    { stripeEventId: event.id, type: event.type, kind: notice.kind },
    'billing_email_sent'
  );
}

async function deliver(event: Stripe.Event, notice: BillingNotice): Promise<void> {
  const householdId = await resolveHouseholdId(notice);
  if (householdId === null) {
    // Named, not silent: a notice we cannot address is a real gap (an older
    // customer with no pointer yet), and it must be visible in the logs
    // rather than looking like "nothing to send".
    logger.warn(
      {
        stripeEventId: event.id,
        type: event.type,
        kind: notice.kind,
        stripeCustomerId: notice.stripeCustomerId,
      },
      'billing_email_household_unresolved'
    );
    return;
  }
  await rememberCustomerPointer(householdId, notice.stripeCustomerId);

  const recipients = adminRecipients(await householdService.getHouseholdMembers(householdId));
  if (recipients.length === 0) {
    logger.warn(
      { stripeEventId: event.id, type: event.type, kind: notice.kind, householdId },
      'billing_email_no_recipient'
    );
    return;
  }

  const currentPlan = needsCurrentPlan(notice) ? await readHouseholdPlan(householdId) : undefined;
  for (const recipient of recipients) {
    await sendToRecipient(event, notice, recipient, currentPlan, DEFAULT_BILLING_EMAIL_LOCALE);
  }
}

/**
 * Send whatever money-lifecycle email this Stripe event calls for, if any.
 *
 * Called twice from `billing.applyStripeEvent`, once per phase:
 *   - `charge`       BEFORE any branch, because the facts it reports are
 *                    already true at Stripe and several of its events carry no
 *                    subscription delta at all.
 *   - `state_change` AFTER the delta was applied, so the guards that skip an
 *                    out-of-order or mismatched delivery skip its email too.
 *
 * NEVER throws. A 5xx from the webhook makes Stripe redeliver the whole event,
 * which would re-run a subscription apply and, for a lifetime purchase, a
 * Stripe cancellation. An undelivered email is not worth that, and the
 * per-recipient marker is released on failure so a redelivery or a manual
 * dashboard resend still gets one clean attempt.
 */
export async function dispatchBillingEmails(
  event: Stripe.Event,
  phase: BillingNoticePhase
): Promise<void> {
  try {
    const notice = billingNoticeForEvent(event);
    if (notice === null || notice.phase !== phase) return;
    await deliver(event, notice);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, stripeEventId: event.id, type: event.type, phase },
      'billing_email_dispatch_failed'
    );
  }
}

/**
 * Confirm to a user that their account was deleted.
 *
 * Sent from `DELETE /me` after every destructive step has succeeded — never
 * before, so it cannot promise a deletion that then failed halfway.
 *
 * Deliberately keeps NO delivery marker. Every other email here rides an
 * at-least-once event stream and needs one; this one rides a single
 * synchronous request whose second attempt cannot succeed (the Cognito user is
 * gone). Writing a marker would also re-create a row under the `USER#{id}`
 * partition that the same request has just erased, which would be a small but
 * real erasure defect of its own.
 *
 * Best-effort by design: a failure here is logged and swallowed, because the
 * deletion has already happened and cannot be undone by refusing to confirm
 * it.
 */
export async function sendAccountDeletionEmail(args: {
  email: string;
  /** Households erased outright because the user was their only member. */
  soleMemberHouseholds: number;
  /** Households that keep going, where the user's history was pseudonymized. */
  sharedHouseholds: number;
  locale?: BillingEmailLocale;
}): Promise<boolean> {
  let delivered = false;
  try {
    const { subject, text } = composeAccountDeletionEmail(
      args.locale ?? DEFAULT_BILLING_EMAIL_LOCALE,
      appBaseUrl(),
      args.soleMemberHouseholds,
      args.sharedHouseholds
    );
    delivered = await emailNotifier.sendEmail({ to: args.email, subject, text });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'account_deletion_email_failed');
  }
  return delivered;
}
