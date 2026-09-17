/**
 * The proactive counterpart to PR #790's in-app "Checkout left unfinished"
 * notice: an EventBridge-scheduled scan that emails a household's admins once
 * a pending plan checkout has gone genuinely stale, instead of waiting for an
 * admin to happen to open Settings → Billing.
 *
 * ## Reuses #790's staleness logic; does not reinvent it
 *
 * "Genuinely stale" is decided ENTIRELY by `billing.getHouseholdSubscription`,
 * which derives `staleCheckout` from `staleCheckoutMarker`/
 * `pendingCheckoutState` — the exact same read `GET /billing/me` already
 * performs. This module adds no second staleness threshold, no independent
 * clock comparison against `PENDING_CHECKOUT_WINDOW_MS`, nothing that could
 * drift from what the in-app notice shows. A household with `staleCheckout ===
 * undefined` (no marker, a fresh one, or an undated one — see that field's own
 * doc in `services/billing.ts`) is not visited at all. That is also why this
 * job coexists with #790 without contradiction: it can only ever email about a
 * checkout the in-app notice would ALSO be showing right now, never one it
 * would stay silent about.
 *
 * ## What it never touches
 *
 * `pendingCheckoutSessionId` / `pendingCheckoutAt` on the household METADATA
 * row — the marker `staleCheckoutMarker` reads — are owned entirely by
 * `services/billing.ts` (`claimPendingCheckout`, `clearPendingCheckout`, the
 * `settlesPendingCheckout` branch of `applyStripeEvent`). This module never
 * writes to that row. Its own "already emailed" state lives in a SEPARATE
 * item, described below, so a settled checkout (`applyStripeEvent` clears the
 * marker in the same write that records the subscription — including for a
 * delayed `checkout.session.async_payment_succeeded`) simply stops being
 * visited on the next run: `staleCheckout` reads back `undefined` and
 * `processHousehold` returns immediately, with nothing to undo.
 *
 * ## Exactly once per checkout ATTEMPT, per admin
 *
 * `staleCheckout.startedAt` is `pendingCheckoutAt` — a fresh timestamp every
 * time `claimPendingCheckout` hands out a new Session, including a second
 * attempt after the first one went stale and was superseded. Keying the
 * "already sent" marker on `(householdId, startedAt, recipientUserId)` means:
 *   - a second scheduled run before the household reattempts sees the SAME
 *     `startedAt` and the SAME claimed marker, so it never double-sends;
 *   - a genuinely NEW attempt gets its own `startedAt` and therefore its own
 *     marker, so it is eligible for its own recovery email — this is what
 *     "per specific checkout attempt" in the task means, and the only
 *     identifier of an attempt this module has, because
 *     `HouseholdSubscription.staleCheckout` deliberately never leaks the raw
 *     Stripe Session id (same discipline #790's tests pin);
 *   - one admin's failed/suppressed send never blocks the household's other
 *     admins, the same property `services/billingEmails.ts` keeps for the
 *     money-lifecycle emails.
 *
 * The claim/lease/finalize shape below MIRRORS `services/billingEmails.ts`'s
 * per-recipient marker (see that file's header for the full reasoning: why a
 * failed or dry-run send releases its slot, why a confirmed SES send never
 * reopens it, why `forceCloseSlot` exists for a finalize that fails after SES
 * already accepted the message). It is not imported from there because that
 * module keys its marker inside the Stripe-event ledger partition
 * (`STRIPE_EVENT#{eventId}`) — this job has no Stripe event to key from, only
 * a household id and an attempt timestamp, so the marker lives under the
 * household's own partition instead.
 */
import { randomUUID } from 'node:crypto';
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { firstAllowedOrigin } from '../middleware/cors.js';
import { getHouseholdSubscription } from './billing.js';
import * as householdService from './householdService.js';
import * as emailNotifier from './emailNotifier.js';
import { resolveEmailLocaleForUser } from './email/locale.js';
import { composeCheckoutRecoveryEmail } from './checkoutRecoveryEmailCopy.js';
import { fanOutHouseholds, type FanOutOptions } from './scheduledFanOut.js';
import type { HouseholdMember } from '../models/types.js';

/** Long enough for a cold start plus an SES call, short enough that a Lambda
 *  killed mid-send frees the slot well before the next 15-30 minute run. */
const EMAIL_LEASE_SECONDS = 5 * 60;
/** A checkout attempt cannot be reattempted forever; 30 days comfortably
 *  outlives any realistic "I'll finish this later" gap and matches the TTL
 *  `billingEmails.ts` uses for its own per-recipient markers. */
const MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;

function householdPartition(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

/** Per attempt (`startedAt`) AND per recipient — see the module header. */
function markerSortKey(startedAt: string, userId: string): string {
  return `CHECKOUT_RECOVERY_EMAIL#${startedAt}#${userId}`;
}

function appBaseUrl(): string {
  return process.env.FRONTEND_URL || firstAllowedOrigin() || 'https://familygreenhouse.net';
}

/**
 * Who hears about an abandoned checkout: the household's admins, the same
 * population #790's in-app notice is gated to ("only an admin can have
 * started the checkout") and `billingEmails.ts` mails for money-lifecycle
 * events. Duplicated from `billingEmails.ts`'s own (unexported) helper rather
 * than imported — the rule is three lines and stable, and importing it would
 * buy a cross-module dependency for no shared behaviour.
 */
function adminRecipients(members: HouseholdMember[]): Array<{ userId: string; email: string }> {
  return members
    .filter((m) => m.role === 'admin' && typeof m.email === 'string' && m.email.includes('@'))
    .map((m) => ({ userId: m.userId, email: m.email }));
}

// ---------------------------------------------------------------------------
// The per-recipient, per-attempt exactly-once marker
// ---------------------------------------------------------------------------

async function claimSlot(
  householdId: string,
  sortKey: string,
  reservationId: string
): Promise<boolean> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: householdPartition(householdId),
          SK: sortKey,
          entityType: 'CheckoutRecoveryEmailMarker',
          status: 'sending',
          reservationId,
          leaseExpiresAt: nowEpoch + EMAIL_LEASE_SECONDS,
          ttl: nowEpoch + MARKER_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(PK) OR (#status = :sending AND leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':sending': 'sending', ':now': nowEpoch },
      })
    );
    return true;
  } catch (err) {
    // Already sent for this attempt, or another concurrent run holds the
    // lease — either way, never send here.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function releaseSlot(
  householdId: string,
  sortKey: string,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: householdPartition(householdId), SK: sortKey },
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}

async function finalizeSlot(
  householdId: string,
  sortKey: string,
  reservationId: string
): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: householdPartition(householdId), SK: sortKey },
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

/** See `billingEmails.ts`'s `forceCloseSlot` for the full reasoning: closes a
 *  marker unconditionally after SES already accepted the message but the
 *  conditional finalize failed, so an expired lease can never let a later run
 *  reclaim the slot and send a second copy of this email. */
async function forceCloseSlot(householdId: string, sortKey: string): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: householdPartition(householdId),
        SK: sortKey,
        entityType: 'CheckoutRecoveryEmailMarker',
        status: 'sent',
        sentAt: new Date().toISOString(),
        finalizeRecovered: true,
        ttl: nowEpoch + MARKER_TTL_SECONDS,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

export interface CheckoutRecoveryRunSummary {
  /** Households enumerated this run (unchanged by truncation). */
  households: number;
  /** Households actually visited. Below `households` when truncated. */
  attempted: number;
  /** True when the fan-out stopped on its deadline with households left. */
  truncated: boolean;
  /** Households whose marker read genuinely `stale` this run. */
  stale: number;
  /** Recovery emails SES accepted. */
  sent: number;
  /** Recipient slots already claimed — the exactly-once guard doing its job,
   *  not an error. */
  alreadySent: number;
  /** A stale household with no admin carrying an address. */
  noRecipient: number;
  /** A claimed slot whose send did not land (dry run, suppression, SES
   *  error) — released so a later run may retry. */
  failed: number;
  /** A household that threw outside the paths above; counted, never fatal. */
  errors: number;
}

function emptySummary(): CheckoutRecoveryRunSummary {
  return {
    households: 0,
    attempted: 0,
    truncated: false,
    stale: 0,
    sent: 0,
    alreadySent: 0,
    noRecipient: 0,
    failed: 0,
    errors: 0,
  };
}

async function sendToRecipient(
  householdId: string,
  startedAt: string,
  recipient: { userId: string; email: string },
  now: Date,
  summary: CheckoutRecoveryRunSummary
): Promise<void> {
  const sortKey = markerSortKey(startedAt, recipient.userId);
  const reservationId = randomUUID();
  const claimed = await claimSlot(householdId, sortKey, reservationId);
  if (!claimed) {
    summary.alreadySent += 1;
    logger.info(
      { householdId, userId: recipient.userId, msg: 'checkout_recovery.duplicate_skipped' },
      'checkout_recovery.duplicate_skipped'
    );
    return;
  }

  let delivered: boolean;
  try {
    const { locale } = await resolveEmailLocaleForUser(recipient.userId, householdId);
    const { subject, text } = composeCheckoutRecoveryEmail({
      locale,
      appUrl: appBaseUrl(),
      startedAt,
      now,
    });
    delivered = await emailNotifier.sendEmail({ to: recipient.email, subject, text });
  } catch (err) {
    // Explicit, not merely the initializer surviving: whether
    // `resolveEmailLocaleForUser` or `sendEmail` itself is what threw,
    // "not delivered" is the correct and ONLY safe reading — it is exactly
    // `emailNotifier.sendEmail`'s own settled-false ("nothing left the
    // building"), and the branch below reacts to it the same way either
    // way: free the slot so a later run retries. There is no distinct
    // "we don't know" state to preserve, because a checkout that is
    // genuinely still stale next run is indistinguishable from — and
    // requires the exact same response as — one this attempt failed to mail.
    delivered = false;
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'checkout_recovery.send_failed' },
      'checkout_recovery.send_failed'
    );
  }

  if (!delivered) {
    summary.failed += 1;
    // A dry run (SES unconfigured) and a real failure both land here. Free
    // the slot so a later run — the household is still `stale`, since this
    // module never touches the marker that says so — can try again.
    await releaseSlot(householdId, sortKey, reservationId).catch((err) => {
      logger.warn(
        { err: (err as Error).message, householdId, msg: 'checkout_recovery.release_failed' },
        'checkout_recovery.release_failed'
      );
    });
    return;
  }

  summary.sent += 1;
  await finalizeSlot(householdId, sortKey, reservationId).catch(async (err) => {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'checkout_recovery.finalize_failed' },
      'checkout_recovery.finalize_failed'
    );
    await forceCloseSlot(householdId, sortKey).catch((closeErr) => {
      logger.error(
        {
          err: (closeErr as Error).message,
          householdId,
          msg: 'checkout_recovery.marker_left_reclaimable',
        },
        'checkout_recovery.marker_left_reclaimable'
      );
    });
  });
}

/**
 * One household. NEVER throws — `fanOutHouseholds` runs a batch with
 * `Promise.all`, and one household's failure must not take its batch-mates
 * down with it (see `scheduledFanOut.ts`'s own doc on `handle`).
 */
async function processHousehold(
  householdId: string,
  now: Date,
  summary: CheckoutRecoveryRunSummary
): Promise<void> {
  try {
    // THE staleness check. Nothing below re-derives it: see the module header
    // on why this is `billing.getHouseholdSubscription` and nothing else.
    const subscription = await getHouseholdSubscription(householdId);
    if (!subscription.staleCheckout) return;
    summary.stale += 1;

    const members = await householdService.getHouseholdMembers(householdId);
    const recipients = adminRecipients(members);
    if (recipients.length === 0) {
      summary.noRecipient += 1;
      logger.warn(
        { householdId, msg: 'checkout_recovery.no_recipient' },
        'checkout_recovery.no_recipient'
      );
      return;
    }

    for (const recipient of recipients) {
      await sendToRecipient(
        householdId,
        subscription.staleCheckout.startedAt,
        recipient,
        now,
        summary
      );
    }
  } catch (err) {
    summary.errors += 1;
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'checkout_recovery.household_failed' },
      'checkout_recovery.household_failed'
    );
  }
}

/**
 * The scheduled pass. Enumerates every household (same directory
 * `services/reminders.ts` uses) and fans out through the shared bounded,
 * deadline-aware walker so a large household count degrades to `truncated:
 * true` on the next run instead of a Lambda timeout silently dropping the
 * tail — see `scheduledFanOut.ts`.
 */
export async function runCheckoutRecoveryEmails(
  now: Date = new Date(),
  options: FanOutOptions = {}
): Promise<CheckoutRecoveryRunSummary> {
  const summary = emptySummary();
  const ids = await householdService.listAllHouseholdIds();
  const fanOut = await fanOutHouseholds(
    'checkoutRecovery',
    ids,
    (householdId) => processHousehold(householdId, now, summary),
    options
  );
  summary.households = fanOut.total;
  summary.attempted = fanOut.attempted;
  summary.truncated = fanOut.truncated;

  logger.info(
    { msg: 'checkout_recovery.run_complete', ...summary },
    'checkout_recovery.run_complete'
  );
  return summary;
}
