/**
 * The two no-card-trial lifecycle emails (ADR 0039): day 10, "your trial ends
 * in 4 days", and day 14, "you are back on Seedling, nothing was deleted".
 *
 * A scheduled scan, not an event: ADR 0027 decided the trial ends on the clock
 * with no job and no write at day 14, and this keeps that true. The scan only
 * READS the trial state (`noCardTrialState`) and mails; it never writes to the
 * household row, so it cannot move, extend or end a trial.
 *
 * ## Off by default
 *
 * `trialLifecycleEmailsEnabled()` (`TRIAL_LIFECYCLE_EMAILS_ENABLED=true`) is
 * checked before anything else, before the household list is read. With it off
 * the run reads nothing, writes nothing and sends nothing.
 *
 * ## Who is mailed, and when
 *
 *   - Households only while `noCardTrialState` says so. `hasStripeEntitlementState`
 *     and a running gift both make that `none`, so a household that subscribed,
 *     or was gifted a plan, during the trial is never told it is "back on
 *     Seedling".
 *   - `trial_day10`: the trial is `active` and ends in 4 days or fewer. Sent
 *     from the first scan inside that window, so a missed scan costs a day,
 *     not the email.
 *   - `trial_day14`: the trial is `ended`, and ended no more than 3 days ago.
 *     An older end is not mailed: "you are back on Seedling" a month late is
 *     noise, and the flag may be switched on long after households' trials
 *     ended. That also means turning the flag on does not mail the backlog.
 *   - Admins only, by the same rule the billing and checkout-recovery emails
 *     use: they are the only people who can act on a plan.
 *
 * ## The rules of the existing system, kept
 *
 *   - Consent: `prefs.email` AND `prefs.trialNotices`. The latter is switched
 *     off by the one-click unsubscribe in the email itself (category
 *     `trial_notices`), with `List-Unsubscribe` and `List-Unsubscribe-Post`.
 *   - Quiet hours: a recipient inside their DND window is skipped WITHOUT
 *     claiming the slot, so the next daily scan can still deliver.
 *   - Suppression: sent through `emailNotifier.sendEmailAccepted`, which
 *     refuses a bounced, complaining or unknown-status address. A refusal
 *     releases the slot, so an address resumed later (#433) still receives it
 *     inside the window; nothing is recorded as sent.
 *   - Exactly once: a per-household, per-kind, per-recipient marker, with the
 *     same claim, lease, release and finalize shape as
 *     `checkoutRecoveryEmails.ts`.
 *   - Replies: Reply-To is the configured support inbox
 *     (`SES_REPLY_TO`), set by `emailNotifier`; this module does not override it.
 */
import { randomUUID } from 'node:crypto';
import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { trialLifecycleEmailsEnabled } from '../config/trialLifecycleEmails.js';
import { NO_CARD_TRIAL_DAYS, noCardTrialState } from '../models/plans.js';
import type { HouseholdMember } from '../models/types.js';
import { getHouseholdSubscription } from './billing.js';
import * as householdService from './householdService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as emailNotifier from './emailNotifier.js';
import { mintUnsubscribeToken } from './email/capability.js';
import { unsubscribeUrl } from './email/links.js';
import { resolveEmailLocale, householdLocaleFrom } from './email/locale.js';
import { fanOutHouseholds, type FanOutOptions } from './scheduledFanOut.js';
import { readTrialFacts, type TrialFacts } from './trialLifecycleFacts.js';
import { composeTrialLifecycleEmail, type TrialEmailKind } from './trialLifecycleEmailCopy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Day 10 of 14: the "ends in 4 days" email goes out once 4 days or fewer remain. */
export const DAY10_DAYS_BEFORE_END = 4;
/** The day-14 email is only for a trial that ended within this many days. */
export const DAY14_MAX_DAYS_AFTER_END = 3;

const EMAIL_LEASE_SECONDS = 5 * 60;
/** Outlives both windows above with room to spare. */
const MARKER_TTL_SECONDS = 60 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Which email, if any, is due (pure)
// ---------------------------------------------------------------------------

export interface TrialEmailDue {
  kind: TrialEmailKind;
  endsAt: string;
  /** Start of the trial, derived from the end and the trial length. */
  startedAt: string;
  /** The household row's `createdAt`, for the free caps the email names. */
  householdCreatedAt?: string | null;
}

/**
 * The email a household is owed right now, or null.
 *
 * Reads `noCardTrialState`, the definition of record for whether a trial is
 * running, so Stripe state and gifts are excluded by the same rule the
 * entitlement code uses.
 */
export function trialEmailDue(
  sub: Parameters<typeof noCardTrialState>[0],
  now: Date
): TrialEmailDue | null {
  const state = noCardTrialState(sub, now);
  if (state === 'none' || !sub.noCardTrialEndsAt) return null;
  const endsAtMs = Date.parse(sub.noCardTrialEndsAt);
  if (!Number.isFinite(endsAtMs)) return null;
  const startedAt = new Date(endsAtMs - NO_CARD_TRIAL_DAYS * DAY_MS).toISOString();
  const base = {
    endsAt: sub.noCardTrialEndsAt,
    startedAt,
    householdCreatedAt: sub.householdCreatedAt,
  };
  if (state === 'active') {
    return endsAtMs - now.getTime() <= DAY10_DAYS_BEFORE_END * DAY_MS
      ? { kind: 'trial_day10', ...base }
      : null;
  }
  return now.getTime() - endsAtMs <= DAY14_MAX_DAYS_AFTER_END * DAY_MS
    ? { kind: 'trial_day14', ...base }
    : null;
}

// ---------------------------------------------------------------------------
// Exactly-once marker (mirrors checkoutRecoveryEmails.ts)
// ---------------------------------------------------------------------------

const partition = (householdId: string) => `HOUSEHOLD#${householdId}`;
const markerSortKey = (kind: TrialEmailKind, userId: string) => `TRIAL_EMAIL#${kind}#${userId}`;

async function claimSlot(householdId: string, sk: string, reservationId: string): Promise<boolean> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: partition(householdId),
          SK: sk,
          entityType: 'TrialLifecycleEmailMarker',
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
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function releaseSlot(householdId: string, sk: string, reservationId: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: partition(householdId), SK: sk },
      ConditionExpression: 'reservationId = :reservationId',
      ExpressionAttributeValues: { ':reservationId': reservationId },
    })
  );
}

async function finalizeSlot(householdId: string, sk: string, reservationId: string): Promise<void> {
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: partition(householdId), SK: sk },
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

/** SES accepted the message but the conditional finalize failed: close the
 *  marker unconditionally so an expired lease can never allow a second copy. */
async function forceCloseSlot(householdId: string, sk: string): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: partition(householdId),
        SK: sk,
        entityType: 'TrialLifecycleEmailMarker',
        status: 'sent',
        sentAt: new Date().toISOString(),
        finalizeRecovered: true,
        ttl: nowEpoch + MARKER_TTL_SECONDS,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface TrialEmailRunSummary {
  /** False when the flag is off; every other field is then zero. */
  enabled: boolean;
  households: number;
  attempted: number;
  truncated: boolean;
  /** Households owed an email this run. */
  due: number;
  sent: number;
  /** The slot was already claimed or sent: the exactly-once guard working. */
  alreadySent: number;
  /** Recipient turned email or trial notices off. */
  optedOut: number;
  /** Recipient inside quiet hours; slot left unclaimed for a later scan. */
  quietHours: number;
  /** emailNotifier refused: suppressed address, unknown suppression status, or dry run. */
  notDelivered: number;
  noRecipient: number;
  errors: number;
}

function emptySummary(enabled: boolean): TrialEmailRunSummary {
  return {
    enabled,
    households: 0,
    attempted: 0,
    truncated: false,
    due: 0,
    sent: 0,
    alreadySent: 0,
    optedOut: 0,
    quietHours: 0,
    notDelivered: 0,
    noRecipient: 0,
    errors: 0,
  };
}

function adminRecipients(members: HouseholdMember[]): HouseholdMember[] {
  return members.filter(
    (m) => m.role === 'admin' && typeof m.email === 'string' && m.email.includes('@')
  );
}

async function sendToRecipient(
  householdId: string,
  due: TrialEmailDue,
  member: HouseholdMember,
  householdLocale: ReturnType<typeof householdLocaleFrom>,
  prefs: notificationPrefs.NotificationPreferences,
  getFacts: () => Promise<TrialFacts>,
  now: Date,
  summary: TrialEmailRunSummary
): Promise<void> {
  const sk = markerSortKey(due.kind, member.userId);
  const reservationId = randomUUID();
  if (!(await claimSlot(householdId, sk, reservationId))) {
    summary.alreadySent += 1;
    return;
  }

  let delivered: boolean;
  try {
    const { locale } = resolveEmailLocale(prefs.emailLocale, householdLocale);
    const minted = await mintUnsubscribeToken(member.userId, 'trial_notices');
    let unsubscribe: string | null = null;
    if (minted.status === 'ok') {
      const built = unsubscribeUrl(minted.token);
      unsubscribe = built ? `${built}&lang=${locale}` : null;
    }
    if (!unsubscribe) {
      logger.warn(
        { householdId, userId: member.userId, msg: 'trial_email.unsubscribe_link_unavailable' },
        'trial_email.unsubscribe_link_unavailable'
      );
    }
    const facts = await getFacts();
    const composed = composeTrialLifecycleEmail({
      kind: due.kind,
      locale,
      recipientName: member.name || null,
      endsAt: due.endsAt,
      now,
      timeZone: prefs.timezone || 'UTC',
      facts,
      unsubscribeUrl: unsubscribe,
      householdCreatedAt: due.householdCreatedAt,
    });
    const acceptance = await emailNotifier.sendEmailAccepted({
      to: member.email,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      headers: composed.headers,
    });
    delivered = acceptance.accepted;
    if (!delivered) {
      logger.info(
        { householdId, userId: member.userId, reason: acceptance.reason, kind: due.kind },
        'trial_email.not_delivered'
      );
    }
  } catch (err) {
    // Explicit, not an initializer surviving: whether the token mint, the
    // facts read, the composer or the send threw, "not delivered" is the only
    // safe reading and the branch below reacts to it the same way: release
    // the slot so a later scan inside the window retries. No distinct "we
    // don't know" state exists to preserve, because nothing was recorded as
    // sent.
    delivered = false;
    logger.warn(
      { err: (err as Error).message, householdId, kind: due.kind },
      'trial_email.send_failed'
    );
  }

  if (!delivered) {
    summary.notDelivered += 1;
    await releaseSlot(householdId, sk, reservationId).catch((err) => {
      logger.warn({ err: (err as Error).message, householdId }, 'trial_email.release_failed');
    });
    return;
  }

  summary.sent += 1;
  await finalizeSlot(householdId, sk, reservationId).catch(async (err) => {
    logger.warn({ err: (err as Error).message, householdId }, 'trial_email.finalize_failed');
    await forceCloseSlot(householdId, sk).catch((closeErr) => {
      logger.error(
        { err: (closeErr as Error).message, householdId },
        'trial_email.marker_left_reclaimable'
      );
    });
  });
}

async function processHousehold(
  householdId: string,
  now: Date,
  summary: TrialEmailRunSummary
): Promise<void> {
  try {
    const subscription = await getHouseholdSubscription(householdId);
    const due = trialEmailDue(subscription, now);
    if (!due) return;
    summary.due += 1;

    const members = await householdService.getHouseholdMembers(householdId);
    const recipients = adminRecipients(members);
    if (recipients.length === 0) {
      summary.noRecipient += 1;
      logger.warn({ householdId, kind: due.kind }, 'trial_email.no_recipient');
      return;
    }

    const prefsByUser = new Map<string, notificationPrefs.NotificationPreferences>();
    for (const member of members) {
      prefsByUser.set(member.userId, await notificationPrefs.getPreferences(member.userId));
    }
    const householdLocale = householdLocaleFrom(
      members.map((member) => prefsByUser.get(member.userId)?.emailLocale)
    );

    // One facts read per household, shared by its admins and made only if
    // somebody is actually going to be mailed.
    let facts: Promise<TrialFacts> | null = null;
    const windowEnd = new Date(Math.min(now.getTime(), Date.parse(due.endsAt))).toISOString();
    const getFacts = () => (facts ??= readTrialFacts(householdId, due.startedAt, windowEnd));

    for (const member of recipients) {
      const prefs = prefsByUser.get(member.userId);
      if (!prefs || !prefs.email || !prefs.trialNotices) {
        summary.optedOut += 1;
        continue;
      }
      if (notificationPrefs.isInDndWindow(prefs, now)) {
        summary.quietHours += 1;
        continue;
      }
      await sendToRecipient(
        householdId,
        due,
        member,
        householdLocale,
        prefs,
        getFacts,
        now,
        summary
      );
    }
  } catch (err) {
    summary.errors += 1;
    logger.warn({ err: (err as Error).message, householdId }, 'trial_email.household_failed');
  }
}

/**
 * The scheduled pass. With the flag off it returns immediately: no household
 * list, no read, no write, no send.
 */
export async function runTrialLifecycleEmails(
  now: Date = new Date(),
  options: FanOutOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<TrialEmailRunSummary> {
  if (!trialLifecycleEmailsEnabled(env)) {
    logger.info({ msg: 'trial_email.disabled' }, 'trial_email.disabled');
    return emptySummary(false);
  }
  const summary = emptySummary(true);
  const ids = await householdService.listAllHouseholdIds();
  const fanOut = await fanOutHouseholds(
    'trialEmails',
    ids,
    (householdId) => processHousehold(householdId, now, summary),
    options
  );
  summary.households = fanOut.total;
  summary.attempted = fanOut.attempted;
  summary.truncated = fanOut.truncated;
  logger.info({ msg: 'trial_email.run_complete', ...summary }, 'trial_email.run_complete');
  return summary;
}
