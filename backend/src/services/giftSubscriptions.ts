/**
 * Gift subscriptions (ADR 0028): the purchase, and the decision to redeem.
 *
 * Checkout is mechanically the identification top-up (`mode: 'payment'`, no
 * subscription_data, no trial) with three differences that matter:
 *
 *   1. The buyer pays with their OWN card. No Stripe customer is attached, so
 *      Checkout cannot offer a saved payment method belonging to the buyer's
 *      household admin, and the charge lands on nobody's subscription history.
 *   2. The Session carries NO `householdId` and NO `client_reference_id`. A
 *      gift is for somebody else; the buyer's household must not be granted,
 *      receipted, or told anything. Every existing reader of a checkout event
 *      keys on those two fields and therefore sees nothing to do.
 *   3. The amount is the tier's monthly price times `quantity` — the months —
 *      against a ONE-MONTH one-time price, reconciled against the catalog
 *      before the Session is minted. No discount, by design (ADR 0012).
 *
 * Redemption is where the policy lives: which households may take a gift and
 * which refusals never consume the code. Every refusal here leaves the code
 * exactly as it was.
 *
 * Lives beside `billing.ts` rather than inside it, like the top-up, so the
 * subscription path's hunk stays small; it borrows the Stripe client, the
 * household read and the live-subscription rule from there.
 */
import type Stripe from 'stripe';
import { assertPaymentActivityAllowed } from '../config/commercialStatus.js';
import {
  GIFT_PRICE_ENV,
  GIFT_SUBSCRIPTION_PURCHASE_KIND,
  addCalendarMonthsUtc,
  giftPriceId,
  isValidGiftMonths,
  normalizeGiftCode,
  type GiftablePlanId,
} from '../models/giftSubscriptions.js';
import { giftState, planRank } from '../models/plans.js';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  getHouseholdSubscription,
  getStripe,
  hasLiveStripeSubscription,
} from './billing.js';
import { findGiftByCode, redeemGift } from './giftCodes.js';
import { assertGiftPriceMatchesCatalog } from './stripePrices.js';
import { audit } from '../utils/auditLog.js';

export interface GiftCheckoutArgs {
  buyerUserId: string;
  buyerEmail: string;
  planId: GiftablePlanId;
  months: number;
  successUrl: string;
  cancelUrl: string;
  /** Stable per click; Stripe returns the same Session on a safe retry. */
  idempotencyKey?: string;
}

/** Error prefixes the handler maps to client-correctable statuses. */
export const GIFT_NOT_CONFIGURED = 'GIFT_NOT_CONFIGURED';
export const GIFT_MONTHS_INVALID = 'GIFT_MONTHS_INVALID';

export async function createGiftCheckoutSession(args: GiftCheckoutArgs): Promise<{ url: string }> {
  // Same gate as every other payment surface: refuse before configuration,
  // DynamoDB, or Stripe.
  assertPaymentActivityAllowed();
  if (!isValidGiftMonths(args.months)) {
    throw new Error(`${GIFT_MONTHS_INVALID}: a gift is between 1 and 12 months`);
  }
  const priceId = giftPriceId(args.planId);
  if (!priceId) {
    throw new Error(
      `${GIFT_NOT_CONFIGURED}: ${GIFT_PRICE_ENV[args.planId]} is not set; the ${args.planId} tier cannot be given as a gift in this environment.`
    );
  }
  const stripe = await getStripe();
  // The one-month gift price must charge exactly the tier's monthly price.
  // The webhook grants `months` from the metadata stamped below, NOT from
  // what Stripe charged, so an unreconciled price id would bill whatever it
  // bills and still hand over the months — the same gap the top-up closed.
  await assertGiftPriceMatchesCatalog(stripe, args.planId, priceId);
  // Deliberately NO householdId and NO client_reference_id: see module doc.
  // `purchase` is the positive marker the webhook branches on; `giftPlanId`
  // and `months` are what the grant reads, so a later change to the offer
  // cannot re-shape a gift already paid for. The key is `giftPlanId`, not
  // `planId`, because every existing reader of `planId` on a checkout event
  // would treat this as a plan purchase for a household it does not name.
  const metadata: Record<string, string> = {
    purchase: GIFT_SUBSCRIPTION_PURCHASE_KIND,
    giftPlanId: args.planId,
    months: String(args.months),
    buyerUserId: args.buyerUserId,
  };
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    customer_email: args.buyerEmail,
    line_items: [{ price: priceId, quantity: args.months }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    metadata,
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === '1' },
  };
  const session = args.idempotencyKey
    ? await stripe.checkout.sessions.create(params, { idempotencyKey: args.idempotencyKey })
    : await stripe.checkout.sessions.create(params);
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}

export type GiftRedeemErrorCode =
  /** Not a well-formed code, or no gift by that code. One answer for both. */
  | 'GIFT_CODE_INVALID'
  | 'GIFT_CODE_REDEEMED'
  | 'GIFT_CODE_EXPIRED'
  /** The household has a live Stripe subscription; a gift cannot pause it. */
  | 'GIFT_HOUSEHOLD_SUBSCRIBED'
  /** A gift is already running on the household. */
  | 'GIFT_ALREADY_ACTIVE'
  /** The household owns this tier, or a higher one, permanently. */
  | 'GIFT_ADDS_NOTHING'
  /** A concurrent change beat this redemption; nothing was consumed. */
  | 'GIFT_REDEEM_CONFLICT';

export class GiftRedeemError extends Error {
  readonly code: GiftRedeemErrorCode;
  readonly details: { endsAt?: string; redeemBy?: string };

  constructor(code: GiftRedeemErrorCode, details: { endsAt?: string; redeemBy?: string } = {}) {
    super(code);
    this.name = 'GiftRedeemError';
    this.code = code;
    this.details = details;
  }
}

export function isGiftRedeemError(error: unknown): error is GiftRedeemError {
  return error instanceof GiftRedeemError;
}

export interface GiftRedemption {
  planId: GiftablePlanId;
  /** ISO 8601. The gift runs from now until this instant. */
  endsAt: string;
}

/**
 * Redeem a code onto a household. Every refusal is a `GiftRedeemError` and
 * leaves the code unspent; the code is consumed only in the same transaction
 * that places the gift on the household.
 *
 * Interactions, decided here and nowhere else:
 *
 *   - **Live Stripe subscription** → refused. Nothing in this codebase may
 *     pause, extend or re-price a running subscription (the price-change
 *     gate), so stacking a gift under one would make the household pay for
 *     months somebody else already bought. The code stays valid for the
 *     household to redeem after the subscription ends, or for another one.
 *   - **Lifetime tier at or above the gift** → refused: the gift adds nothing.
 *   - **A gift already running** → refused until it ends. Codes stay
 *     redeemable for a year, so a second gift is not lost, only queued.
 *   - **The card trial** (`trialConsumedAt`) is untouched. A gift is paid,
 *     not free, so it neither consumes nor grants the 14 free days.
 *   - **The no-card trial** defers to a running gift (`noCardTrialState`).
 *   - **Cancellation at period end** is a Stripe state and is covered by the
 *     first rule: a subscription still serving its last period is live.
 */
export async function redeemGiftCode(args: {
  code: unknown;
  householdId: string;
  now?: Date;
}): Promise<GiftRedemption> {
  const now = args.now ?? new Date();
  const code = normalizeGiftCode(args.code);
  if (!code) throw new GiftRedeemError('GIFT_CODE_INVALID');
  const gift = await findGiftByCode(code);
  if (!gift) throw new GiftRedeemError('GIFT_CODE_INVALID');
  if (gift.redeemedAt) throw new GiftRedeemError('GIFT_CODE_REDEEMED');
  if (gift.redeemByEpoch <= Math.floor(now.getTime() / 1000)) {
    throw new GiftRedeemError('GIFT_CODE_EXPIRED', { redeemBy: gift.redeemBy });
  }

  const sub = await getHouseholdSubscription(args.householdId);
  if (hasLiveStripeSubscription(sub)) throw new GiftRedeemError('GIFT_HOUSEHOLD_SUBSCRIBED');
  if (sub.lifetimePlanId && planRank(gift.planId) <= planRank(sub.lifetimePlanId)) {
    throw new GiftRedeemError('GIFT_ADDS_NOTHING');
  }
  if (giftState(sub, now) === 'active') {
    throw new GiftRedeemError('GIFT_ALREADY_ACTIVE', { endsAt: sub.giftEndsAt ?? undefined });
  }

  const endsAt = addCalendarMonthsUtc(now, gift.months);
  const outcome = await redeemGift({
    gift,
    householdId: args.householdId,
    endsAt,
    now,
    liveSubscriptionStatuses: [...LIVE_SUBSCRIPTION_STATUSES],
  });
  if (outcome === 'code_conflict') throw new GiftRedeemError('GIFT_CODE_REDEEMED');
  if (outcome === 'household_conflict') throw new GiftRedeemError('GIFT_REDEEM_CONFLICT');
  // The Session id names the gift; the code never appears in a log line.
  audit('billing.gift_redeemed', {
    householdId: args.householdId,
    metadata: {
      stripeSessionId: gift.stripeSessionId,
      planId: gift.planId,
      months: gift.months,
      endsAt: endsAt.toISOString(),
    },
  });
  return { planId: gift.planId, endsAt: endsAt.toISOString() };
}
