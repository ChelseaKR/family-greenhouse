/**
 * Restart the no-card Garden trial, once, for a household whose trial ended
 * during the 2026-09-04 to 2026-11-19 email outage and whose admin replied to
 * the outage notice asking for "another 14 days of Garden".
 *
 * Operator-run only, through `scripts/restartOutageTrial.ts`, one household
 * per run. Nothing calls it from a schedule, a webhook or a request handler.
 * It is the narrow exception ADR 0027 records in its 2026-11-19 amendment:
 * the trial is otherwise written once, at household creation.
 *
 * ## What it writes
 *
 * `noCardTrialStartedAt` = now and `noCardTrialEndsAt` = now + 14 days on the
 * household METADATA row, and one marker row,
 * `SERVICE_NOTICE#trial-restart-2026-11 / HOUSEHOLD#{id}`, in the same
 * transaction. Nothing else: no Stripe call, no claim row, no email. The
 * existing daily `trialEmails` job sends the day-10 and day-14 emails from
 * the new dates by itself.
 *
 * ## When it refuses
 *
 *   - The household does not exist.
 *   - `noCardTrialState` is not `ended`. That one rule covers a household with
 *     no trial, a trial still running, and every route to a paid plan: Stripe
 *     state (a status, a subscription id, a lifetime purchase or a paid plan
 *     on file), App Store state and a running gift.
 *   - The trial ended outside the outage window
 *     (`emailOutageNotice.endedTrialDuringOutage`, the same test the notice
 *     used to decide who was offered the 14 days).
 *   - The marker exists: this household was already restarted.
 *
 * The write is conditional on what was read: the old end date unchanged, no
 * Stripe, App Store or lifetime attribute on the row, the plan and gift
 * attributes exactly as read, and the marker absent. A checkout, a purchase,
 * a gift or a second run landing between the read and the write cancels the
 * whole transaction, so nothing is half written.
 *
 * ## Read-only until --confirm
 *
 * `planOutageTrialRestart` only reads (GetItem and Query). Only
 * `restartOutageTrial` writes.
 */
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { appStoreState } from '../models/appStore.js';
import {
  NO_CARD_TRIAL_DAYS,
  giftState,
  hasStripeEntitlementState,
  noCardTrialState,
} from '../models/plans.js';
import type { HouseholdSubscription } from './billing.js';
import * as billing from './billing.js';
import * as householdService from './householdService.js';
import * as notificationPrefs from './notificationPrefs.js';
import { endedTrialDuringOutage, type TrialWindow } from './emailOutageNotice.js';
import { DAY10_DAYS_BEFORE_END, DAY14_MAX_DAYS_AFTER_END } from './trialLifecycleEmails.js';

/** Marker partition id. One restart per household, ever. */
export const RESTART_ID = 'trial-restart-2026-11';

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER_PK = `SERVICE_NOTICE#${RESTART_ID}`;
const markerSk = (householdId: string) => `HOUSEHOLD#${householdId}`;
const metadataKey = (householdId: string) => ({ PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' });

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

export type RestartRefusal =
  | 'no_household'
  | 'no_trial'
  | 'trial_active'
  | 'paid_stripe'
  | 'paid_app_store'
  | 'paid_gift'
  | 'unreadable_end'
  | 'outside_window'
  | 'already_restarted';

export const REFUSAL_TEXT: Record<RestartRefusal, string> = {
  no_household: 'There is no household with that id.',
  no_trial: 'This household never had a no-card trial.',
  trial_active: 'This household’s no-card trial is still running.',
  paid_stripe:
    'This household has Stripe state (a subscription status or id, a lifetime purchase or a paid plan).',
  paid_app_store: 'This household has App Store subscription state.',
  paid_gift: 'This household has a gift running.',
  unreadable_end: 'This household’s trial end date does not parse.',
  outside_window:
    'This household’s trial did not end during the outage (2026-09-04 to 2026-11-19).',
  already_restarted: 'This household’s trial was already restarted once.',
};

/**
 * Why `sub` may not be restarted at `now`, or the old trial window when it
 * may. `noCardTrialState` decides; the branches below only name which of its
 * `none` cases applied, in the order it checks them.
 */
export function restartEligibility(
  sub: HouseholdSubscription,
  now: Date
): { ok: true; trial: TrialWindow } | { ok: false; reason: RestartRefusal } {
  if (!sub.noCardTrialEndsAt) return { ok: false, reason: 'no_trial' };
  const state = noCardTrialState(sub, now);
  if (state === 'active') return { ok: false, reason: 'trial_active' };
  if (state === 'none') {
    if (hasStripeEntitlementState(sub)) return { ok: false, reason: 'paid_stripe' };
    if (giftState(sub, now) === 'active') return { ok: false, reason: 'paid_gift' };
    if (appStoreState(sub, now) !== 'none') return { ok: false, reason: 'paid_app_store' };
    return { ok: false, reason: 'unreadable_end' };
  }
  // `ended`, but App Store attributes that do not parse read as `none` there;
  // a row carrying any is not one to hand a free trial.
  if (sub.appStore) return { ok: false, reason: 'paid_app_store' };
  const trial = endedTrialDuringOutage(sub, now);
  if (!trial) return { ok: false, reason: 'outside_window' };
  return { ok: true, trial };
}

/** The two dates written: the trial starts now and runs NO_CARD_TRIAL_DAYS. */
export function restartDates(now: Date): { startedAt: string; endsAt: string } {
  return {
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + NO_CARD_TRIAL_DAYS * DAY_MS).toISOString(),
  };
}

/**
 * The write condition: the row still says what `sub` says. Every attribute
 * that could make a household paid must be absent (Stripe, App Store,
 * lifetime) or exactly as read (plan, gift), and the trial end unchanged.
 * Built from the read rather than from plan ids, so it names no tier.
 */
export function restartCondition(sub: HouseholdSubscription): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const names: Record<string, string> = { '#trialEnd': 'noCardTrialEndsAt' };
  const values: Record<string, unknown> = { ':oldEnd': sub.noCardTrialEndsAt };
  const parts = ['attribute_exists(PK)', '#trialEnd = :oldEnd'];

  for (const attr of ['subscriptionStatus', 'stripeSubscriptionId', 'lifetimePlanId', 'appStore']) {
    names[`#${attr}`] = attr;
    parts.push(`attribute_not_exists(#${attr})`);
  }

  // `getHouseholdSubscription` reads an absent planId as the free tier, so
  // either an absent attribute or the value read is unchanged.
  names['#planId'] = 'planId';
  values[':planId'] = sub.planId;
  parts.push('(attribute_not_exists(#planId) OR #planId = :planId)');

  const pinned: Array<[string, string | undefined]> = [
    ['giftPlanId', sub.giftPlanId],
    ['giftEndsAt', sub.giftEndsAt],
  ];
  for (const [attr, value] of pinned) {
    names[`#${attr}`] = attr;
    if (value === undefined) {
      parts.push(`attribute_not_exists(#${attr})`);
    } else {
      values[`:${attr}`] = value;
      parts.push(`#${attr} = :${attr}`);
    }
  }

  return {
    ConditionExpression: parts.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

// ---------------------------------------------------------------------------
// Planning (read-only)
// ---------------------------------------------------------------------------

export interface RestartPlan {
  ok: true;
  oldTrial: TrialWindow;
  startedAt: string;
  endsAt: string;
  /** When the day-10 email becomes due, and the day-14 email's window. */
  day10From: string;
  day14Until: string;
  /** Existing TRIAL_EMAIL# markers on the household. Any would stop a resend. */
  trialEmailMarkers: number;
  admins: number;
  /** Admins with an address, `prefs.email` and `prefs.trialNotices` on. */
  adminsReachable: number;
  /** The read the conditional write is pinned to. */
  sub: HouseholdSubscription;
}

export type RestartPlanResult = RestartPlan | { ok: false; reason: RestartRefusal };

async function markerExists(householdId: string): Promise<boolean> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: MARKER_PK, SK: markerSk(householdId) },
      ConsistentRead: true,
    })
  );
  return Boolean(result.Item);
}

async function countTrialEmailMarkers(householdId: string): Promise<number> {
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}`,
          ':sk': 'TRIAL_EMAIL#',
        },
        Select: 'COUNT',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    total += page.Count ?? 0;
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return total;
}

export async function planOutageTrialRestart(
  householdId: string,
  now: Date
): Promise<RestartPlanResult> {
  const household = await householdService.getHousehold(householdId);
  if (!household) return { ok: false, reason: 'no_household' };

  const sub = await billing.getHouseholdSubscription(householdId, now);
  const eligibility = restartEligibility(sub, now);
  if (!eligibility.ok) return eligibility;

  if (await markerExists(householdId)) return { ok: false, reason: 'already_restarted' };

  const members = await householdService.getHouseholdMembers(householdId);
  const admins = members.filter((m) => m.role === 'admin');
  let adminsReachable = 0;
  for (const admin of admins) {
    if (typeof admin.email !== 'string' || !admin.email.includes('@')) continue;
    const prefs = await notificationPrefs.getPreferences(admin.userId);
    if (prefs.email && prefs.trialNotices) adminsReachable += 1;
  }

  const { startedAt, endsAt } = restartDates(now);
  const endsMs = Date.parse(endsAt);
  return {
    ok: true,
    oldTrial: eligibility.trial,
    startedAt,
    endsAt,
    day10From: new Date(endsMs - DAY10_DAYS_BEFORE_END * DAY_MS).toISOString(),
    day14Until: new Date(endsMs + DAY14_MAX_DAYS_AFTER_END * DAY_MS).toISOString(),
    trialEmailMarkers: await countTrialEmailMarkers(householdId),
    admins: admins.length,
    adminsReachable,
    sub,
  };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

export type RestartWriteResult =
  | { status: 'restarted'; startedAt: string; endsAt: string }
  | { status: 'changed' }
  | { status: 'already_restarted' };

function transactCancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

/**
 * Write the new trial dates and the marker in one transaction, conditioned on
 * the read in `plan`. Uses the dates the plan printed, so what the dry run
 * showed is what is written.
 */
export async function restartOutageTrial(
  householdId: string,
  plan: RestartPlan,
  now: Date
): Promise<RestartWriteResult> {
  const condition = restartCondition(plan.sub);
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: metadataKey(householdId),
              UpdateExpression: 'SET #trialStart = :newStart, #trialEnd = :newEnd',
              ConditionExpression: condition.ConditionExpression,
              ExpressionAttributeNames: {
                ...condition.ExpressionAttributeNames,
                '#trialStart': 'noCardTrialStartedAt',
              },
              ExpressionAttributeValues: {
                ...condition.ExpressionAttributeValues,
                ':newStart': plan.startedAt,
                ':newEnd': plan.endsAt,
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: MARKER_PK,
                SK: markerSk(householdId),
                entityType: 'ServiceNoticeMarker',
                householdId,
                previousEndsAt: plan.oldTrial.endedAt,
                startedAt: plan.startedAt,
                endsAt: plan.endsAt,
                restartedAt: now.toISOString(),
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      })
    );
    return { status: 'restarted', startedAt: plan.startedAt, endsAt: plan.endsAt };
  } catch (err) {
    const reasons = transactCancellationReasons(err);
    if (reasons[1]?.Code === 'ConditionalCheckFailed') return { status: 'already_restarted' };
    if (reasons[0]?.Code === 'ConditionalCheckFailed') return { status: 'changed' };
    throw err;
  }
}
