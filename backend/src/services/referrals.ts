/**
 * Refer-a-friend (ADR 0029): the policy layer — who is eligible, the
 * anti-self-referral guard, and crediting both sides once a referred signup
 * has a household. Lives beside `giftSubscriptions.ts`, the same role it
 * plays for gift subscriptions: persistence stays in `referralCodes.ts`
 * (mirroring `giftCodes.ts`), the DECISION lives here.
 *
 * The two halves of a referral are credited at different times and by
 * different paths, on purpose:
 *
 *   1. The NEW household's bonus is decided (`resolveReferralGrant`) and
 *      applied BEFORE the household exists — it rides `createHousehold`'s
 *      own transaction (households/handler.ts -> householdService.ts), so a
 *      household can never exist with a referral code accepted but no bonus
 *      applied, the same guarantee the no-card trial claim already gives
 *      itself (ADR 0027).
 *   2. The REFERRER's bonus is applied AFTER, by `creditReferralAfterSignup`,
 *      because it touches a DIFFERENT household's row and must not be able
 *      to fail the new user's signup. It is deliberately best-effort: a
 *      crash between the two households' writes is recoverable strictly in
 *      the referrer's favor (nothing is charged, nothing is lost that was
 *      not free to begin with) and is accepted rather than built out with a
 *      saga/outbox — see the module doc in `models/referrals.ts` on staying
 *      proportionate.
 */
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { audit } from '../utils/auditLog.js';
import {
  REFERRAL_BONUS_MONTHS,
  REFERRAL_BONUS_PLAN_ID,
  detectSelfReferral,
  normalizeReferralCode,
  type ReferralCode,
} from '../models/referrals.js';
import { addCalendarMonthsUtc, type GiftablePlanId } from '../models/giftSubscriptions.js';
import { giftState, planRank } from '../models/plans.js';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  getHouseholdSubscription,
  hasLiveStripeSubscription,
} from './billing.js';
import * as referralCodes from './referralCodes.js';

export interface ReferralGrant {
  planId: GiftablePlanId;
  /** ISO 8601. */
  endsAt: string;
  referrerUserId: string;
  referrerHouseholdId: string;
  referralCode: ReferralCode;
}

export type ReferralGrantRefusalReason =
  'not_found' | 'self_referral' | 'same_email' | 'shared_custom_domain';

export type ReferralGrantDecision =
  { ok: true; grant: ReferralGrant } | { ok: false; reason: ReferralGrantRefusalReason };

/**
 * Decide whether a referral code presented at signup earns a bonus. Never
 * throws on a bad/unknown/self-referred code — every refusal here means
 * "create the household with no referral bonus", never "refuse the signup".
 *
 * Called BEFORE the new household exists, so this only has the code and the
 * two email addresses to reason from; the DynamoDB-level guard against
 * redeeming twice on the same account (one claim row per account, ever) is
 * enforced downstream by `householdService.createHousehold`, not here — this
 * function's job is the code lookup and the self-referral heuristic only.
 */
export async function resolveReferralGrant(args: {
  code: unknown;
  newUserId: string;
  newUserEmail: string;
  now?: Date;
}): Promise<ReferralGrantDecision> {
  const now = args.now ?? new Date();
  const code = normalizeReferralCode(args.code);
  if (!code) return { ok: false, reason: 'not_found' };
  const owner = await referralCodes.findReferralCodeOwner(code);
  if (!owner) return { ok: false, reason: 'not_found' };
  if (owner.referrerUserId === args.newUserId) return { ok: false, reason: 'self_referral' };
  const selfReferral = detectSelfReferral(owner.referrerEmail, args.newUserEmail);
  if (selfReferral) return { ok: false, reason: selfReferral };
  return {
    ok: true,
    grant: {
      planId: REFERRAL_BONUS_PLAN_ID,
      endsAt: addCalendarMonthsUtc(now, REFERRAL_BONUS_MONTHS).toISOString(),
      referrerUserId: owner.referrerUserId,
      referrerHouseholdId: owner.referrerHouseholdId,
      referralCode: code,
    },
  };
}

type ReferrerGrantOutcome =
  | 'granted'
  /** The referrer's household has a live Stripe subscription — already
   *  paying for at least Garden, so a "free month of Garden" gift would
   *  layer under a real charge rather than replace one. Same refusal
   *  `giftSubscriptions.redeemGiftCode` gives a PAID gift code for the same
   *  reason (ADR 0028): nothing here may pause, extend or re-price a running
   *  subscription. */
  | 'stripe_subscribed'
  /** A gift (purchased or an earlier referral) is already running. */
  | 'gift_active'
  /** The referrer already owns Garden or better for life (a lifetime
   *  purchase); the bonus would add nothing. */
  | 'owns_tier'
  /** Lost a race with a concurrent write between the read above and here. */
  | 'conflict';

/**
 * Place the bonus on the referrer's household, or explain why not. Mirrors
 * `giftCodes.redeemGift`'s household-side condition exactly (no live Stripe
 * subscription, no gift already running) as a single conditional update —
 * there is no "code" to mark redeemed on this side, so unlike a purchased
 * gift this needs only the one write, not a paired transaction.
 */
async function grantReferrerBonus(args: {
  referrerHouseholdId: string;
  now: Date;
}): Promise<ReferrerGrantOutcome> {
  const sub = await getHouseholdSubscription(args.referrerHouseholdId);
  if (hasLiveStripeSubscription(sub)) return 'stripe_subscribed';
  if (giftState(sub, args.now) === 'active') return 'gift_active';
  if (sub.lifetimePlanId && planRank(REFERRAL_BONUS_PLAN_ID) <= planRank(sub.lifetimePlanId)) {
    return 'owns_tier';
  }

  const endsAt = addCalendarMonthsUtc(args.now, REFERRAL_BONUS_MONTHS);
  const statusValues: Record<string, string> = {};
  [...LIVE_SUBSCRIPTION_STATUSES].forEach((status, i) => {
    statusValues[`:live${i}`] = status;
  });
  const liveList = Object.keys(statusValues).join(', ');
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${args.referrerHouseholdId}`, SK: 'METADATA' },
        UpdateExpression:
          'SET giftPlanId = :plan, giftEndsAt = :endsAt, giftSource = :src, giftRedeemedAt = :now',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(giftEndsAt) OR giftEndsAt < :now) AND ' +
          `(attribute_not_exists(stripeSubscriptionId) OR (attribute_exists(subscriptionStatus) AND NOT (subscriptionStatus IN (${liveList}))))`,
        ExpressionAttributeValues: {
          ':plan': REFERRAL_BONUS_PLAN_ID,
          ':endsAt': endsAt.toISOString(),
          ':src': 'referral',
          ':now': args.now.toISOString(),
          ...statusValues,
        },
      })
    );
    return 'granted';
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return 'conflict';
    throw err;
  }
}

/**
 * Credit both sides of a referral once the new household exists. Called by
 * the households handler right after `createHousehold` returns, whenever a
 * grant was resolved for this signup. Never throws — every failure here is
 * logged and swallowed, because by the time this runs the new household
 * already exists and its own bonus (if any) is already committed; nothing
 * about the referrer's side may retroactively fail the signup.
 */
export async function creditReferralAfterSignup(args: {
  grant: ReferralGrant;
  newHouseholdId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  try {
    // Authoritative check, not an assumption: `createHousehold` falls back to
    // a plain create with NO referral bonus if this account's one-per-account
    // claim lost a race (see its doc comment). Reading the household back
    // tells us which path actually ran, so a lost race here simply records
    // nothing rather than crediting a referrer for a bonus the new household
    // never received.
    const newHouseholdSub = await getHouseholdSubscription(args.newHouseholdId);
    if (
      newHouseholdSub.giftPlanId !== args.grant.planId ||
      newHouseholdSub.giftEndsAt !== args.grant.endsAt
    ) {
      return;
    }

    const referrerRewardStatus = await grantReferrerBonus({
      referrerHouseholdId: args.grant.referrerHouseholdId,
      now,
    });
    await referralCodes.recordReferralEvent(args.grant.referrerUserId, {
      referredHouseholdId: args.newHouseholdId,
      signedUpAt: now.toISOString(),
      referredRewardStatus: 'granted',
      referrerRewardStatus: referrerRewardStatus === 'granted' ? 'granted' : 'skipped',
      referrerSkipReason: referrerRewardStatus === 'granted' ? undefined : referrerRewardStatus,
    });
    audit('referral.signup_credited', {
      actorId: args.grant.referrerUserId,
      householdId: args.newHouseholdId,
      metadata: { referrerRewardStatus },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, newHouseholdId: args.newHouseholdId },
      'referral_credit_failed'
    );
  }
}
