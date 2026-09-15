/**
 * Sends the 14-day price-change notice `legal.terms.priceChanges.body`
 * promises (#710), to every household actually affected by an announced
 * plan-price move.
 *
 * `docs/billing.md` § _Price changes, and the notice nothing sends_ recorded
 * that this send path was, deliberately, not built ahead of need — "a
 * seventh notice kind plus a fan-out in the shape `services/scheduledFanOut.ts`
 * provides". This is that fan-out. It is operator-triggered
 * (`backend/scripts/sendPriceChangeNotice.ts`), never automatic: nothing
 * calls it from a webhook, a schedule, or a request handler, because no price
 * change is planned and none should be announced by a change no person chose.
 *
 * ## What "affected" means
 *
 * A household whose stored `planId` matches the announced plan AND holds a
 * live Stripe subscription (`stripeSubscriptionId` set, status `active` or
 * `trialing`). The household row has no separate field for billing cadence —
 * only Stripe's own subscription does — so this cannot distinguish a Garden
 * monthly subscriber from a Garden annual one; both are notified of a Garden
 * price move regardless of which cadence's price actually changed. That is
 * the safe direction for a legal notice: telling an unaffected admin their
 * plan's price "is changing" when only the other cadence moved costs one
 * unnecessary but harmless email, while failing to notify a truly affected
 * admin is the defect #710 was filed about. It is not a defect a future
 * change should "fix" by narrowing without adding a per-household cadence
 * field first.
 *
 * ## Exactly once, without the webhook-redelivery machinery
 *
 * `services/billingEmails.ts`'s claim/send/finalize lease exists because
 * Stripe redelivers events at least once, concurrently, indefinitely. This
 * sender has none of that: one operator runs one script once (or re-runs it
 * after a crash). So the marker is a single conditional Put — claim, then
 * send, then release ONLY on failure. A crash between claim and send leaves a
 * household un-emailed and unmarked, which is recoverable by re-running the
 * script with the same announcement id: already-sent recipients are skipped,
 * not re-mailed twice.
 */
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { audit } from '../utils/auditLog.js';
import { firstAllowedOrigin } from '../middleware/cors.js';
import * as billing from './billing.js';
import * as householdService from './householdService.js';
import * as emailNotifier from './emailNotifier.js';
import {
  composePriceChangeNoticeEmail,
  DEFAULT_BILLING_EMAIL_LOCALE,
  type BillingEmailLocale,
} from './billingEmailCopy.js';
import {
  validatePriceChangeAnnouncement,
  type PriceChangeAnnouncement,
} from '../models/priceChangeAnnouncement.js';
import type { PlanId } from '../models/plans.js';
import type { HouseholdMember } from '../models/types.js';

const CONCURRENCY = 5;

async function mapBounded<T>(
  items: readonly T[],
  action: (item: T) => Promise<void>
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += CONCURRENCY) {
    await Promise.all(items.slice(offset, offset + CONCURRENCY).map(action));
  }
}

function appBaseUrl(): string {
  return process.env.FRONTEND_URL || firstAllowedOrigin() || 'https://familygreenhouse.net';
}

/** Same recipient rule as `services/billingEmails.ts`'s `adminRecipients`:
 *  only admins can open checkout or the portal, so they are the only people
 *  who can act on a price change, and resolved from our own roster rather
 *  than Stripe's so a billing email never reaches an address the household
 *  never put on its member list. Duplicated rather than imported so this
 *  module — read by an operator before every send — states its own
 *  recipient rule in full rather than sending the reader elsewhere. */
function adminRecipients(members: HouseholdMember[]): { userId: string; email: string }[] {
  return members
    .filter((m) => m.role === 'admin' && typeof m.email === 'string' && m.email.includes('@'))
    .map((m) => ({ userId: m.userId, email: m.email }));
}

// ---------------------------------------------------------------------------
// Who is affected
// ---------------------------------------------------------------------------

async function isAffected(householdId: string, planId: PlanId): Promise<boolean> {
  const sub = await billing.getHouseholdSubscription(householdId);
  return (
    sub.planId === planId &&
    Boolean(sub.stripeSubscriptionId) &&
    (sub.status === 'active' || sub.status === 'trialing')
  );
}

/** Every household id currently on `planId` with a live Stripe subscription. */
export async function affectedHouseholdIds(planId: PlanId): Promise<string[]> {
  const ids = await householdService.listAllHouseholdIds();
  const affected: string[] = [];
  await mapBounded(ids, async (householdId) => {
    if (await isAffected(householdId, planId)) affected.push(householdId);
  });
  return affected;
}

// ---------------------------------------------------------------------------
// The per-recipient marker
// ---------------------------------------------------------------------------

function noticePartition(announcementId: string): string {
  return `PRICE_CHANGE_NOTICE#${announcementId}`;
}

function recipientSortKey(userId: string): string {
  return `EMAIL#${userId}`;
}

async function claim(announcementId: string, userId: string): Promise<boolean> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: noticePartition(announcementId),
          SK: recipientSortKey(userId),
          entityType: 'PriceChangeNoticeMarker',
          sentAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Undo a claim after a failed send, so a re-run retries this recipient
 *  instead of reading the marker as "already notified" forever. */
async function release(announcementId: string, userId: string): Promise<void> {
  await dynamodb
    .send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: noticePartition(announcementId), SK: recipientSortKey(userId) },
      })
    )
    .catch((err) => {
      logger.warn(
        { err: (err as Error).message, announcementId, userId },
        'price_change_notice_release_failed'
      );
    });
}

type SendOutcome = 'sent' | 'skipped' | 'failed';

async function sendToRecipient(
  announcement: PriceChangeAnnouncement,
  recipient: { userId: string; email: string },
  householdId: string,
  locale: BillingEmailLocale
): Promise<SendOutcome> {
  const claimed = await claim(announcement.id, recipient.userId);
  if (!claimed) {
    logger.info(
      { announcementId: announcement.id, userId: recipient.userId },
      'price_change_notice_already_sent'
    );
    return 'skipped';
  }

  let delivered = false;
  try {
    const { subject, text } = composePriceChangeNoticeEmail(announcement, {
      locale,
      appUrl: appBaseUrl(),
    });
    delivered = await emailNotifier.sendEmail({ to: recipient.email, subject, text });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, announcementId: announcement.id, userId: recipient.userId },
      'price_change_notice_send_failed'
    );
  }

  if (!delivered) {
    await release(announcement.id, recipient.userId);
    return 'failed';
  }

  audit('billing.price_change_notice_sent', {
    actorId: 'system',
    targetId: recipient.userId,
    householdId,
    metadata: {
      announcementId: announcement.id,
      planId: announcement.planId,
      interval: announcement.interval,
      effectiveOn: announcement.effectiveOn,
    },
  });
  logger.info(
    { announcementId: announcement.id, userId: recipient.userId, householdId },
    'price_change_notice_sent'
  );
  return 'sent';
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface PriceChangeNoticeSummary {
  announcementId: string;
  planId: PlanId;
  /** Households the filter matched, whether or not they had an admin to mail. */
  householdsAffected: number;
  recipientsNotified: number;
  /** Already held a marker from an earlier run of this same announcement. */
  recipientsSkippedAlreadyNotified: number;
  /** Send failed or threw; unmarked, so a re-run retries them. */
  recipientsFailed: number;
}

/**
 * Validate, then send. Throws on an invalid announcement rather than sending
 * a partial or non-compliant notice — there is no undo for an email that
 * already left, so a mistake here must be caught before the first send, not
 * reported after.
 */
export async function sendPriceChangeNotice(
  announcement: PriceChangeAnnouncement,
  options: { today?: string; locale?: BillingEmailLocale } = {}
): Promise<PriceChangeNoticeSummary> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const problems = validatePriceChangeAnnouncement(announcement, today);
  if (problems.length > 0) {
    throw new Error(`price change announcement is not ready to send:\n${problems.join('\n')}`);
  }

  const householdIds = await affectedHouseholdIds(announcement.planId);
  const summary: PriceChangeNoticeSummary = {
    announcementId: announcement.id,
    planId: announcement.planId,
    householdsAffected: householdIds.length,
    recipientsNotified: 0,
    recipientsSkippedAlreadyNotified: 0,
    recipientsFailed: 0,
  };
  const locale = options.locale ?? DEFAULT_BILLING_EMAIL_LOCALE;

  await mapBounded(householdIds, async (householdId) => {
    const members = await householdService.getHouseholdMembers(householdId);
    for (const recipient of adminRecipients(members)) {
      const outcome = await sendToRecipient(announcement, recipient, householdId, locale);
      if (outcome === 'sent') summary.recipientsNotified += 1;
      else if (outcome === 'skipped') summary.recipientsSkippedAlreadyNotified += 1;
      else summary.recipientsFailed += 1;
    }
  });

  return summary;
}
