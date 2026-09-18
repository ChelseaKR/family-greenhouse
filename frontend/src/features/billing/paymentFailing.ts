import type { PlanId, SubscriptionState } from '@/services/billingService';

/**
 * A failed payment has two stages, and they mean opposite things for access.
 *
 *   - `retrying` — `past_due`. Stripe is still retrying the card on its own
 *     schedule and the household KEEPS its paid plan while it does. That is
 *     the owner's decision on #593 (2026-09-17), implemented server-side by
 *     `past_due` being in `ENTITLED_SUBSCRIPTION_STATUSES`
 *     (`backend/src/models/plans.ts`). Nothing has been taken away yet, so
 *     nothing on screen may say it has.
 *   - `lapsed` — `unpaid`, `incomplete`, `incomplete_expired`. Stripe has
 *     given up (or the first payment never succeeded) and the server has
 *     dropped the household's caps to Seedling's, with the lifetime and gift
 *     floors underneath.
 *
 * `canceled` is neither: that is the end of the subscription, not a payment
 * the household can still fix, and the plan row already says `seedling`.
 * `paused` is neither: a live subscription Stripe is not billing on purpose.
 *
 * Every piece of copy about a failed payment — the app-wide banner and the
 * Settings → Plan status notice — goes through this module, so the two can
 * never disagree about which stage a household is in.
 */
export type PaymentFailureStage = 'retrying' | 'lapsed';

/** Stripe is still retrying; access is kept. */
export const PAYMENT_RETRYING_STATUSES: ReadonlySet<string> = new Set(['past_due']);

/** Stripe has given up, or the first payment never went through; caps dropped. */
export const PAYMENT_LAPSED_STATUSES: ReadonlySet<string> = new Set([
  'unpaid',
  'incomplete',
  'incomplete_expired',
]);

/**
 * Which stage of a failed payment this household is in, or `null` when there
 * is no failed payment to describe.
 *
 * Reads a status Stripe actually sent. An ABSENT status is never a failure:
 * `checkout.session.completed` records the subscription id before any status
 * is known, and calling that window "your payment failed" would be a worse
 * claim than the silence it replaces. Once the card goes through, Stripe sends
 * `customer.subscription.updated` with `→ active`, the webhook writes it, and
 * this returns `null` — which is what hides every notice.
 */
export function paymentFailureStage(
  subscription: SubscriptionState | null | undefined
): PaymentFailureStage | null {
  const status = subscription?.status;
  if (!status) return null;
  if (PAYMENT_RETRYING_STATUSES.has(status)) return 'retrying';
  if (PAYMENT_LAPSED_STATUSES.has(status)) return 'lapsed';
  return null;
}

/** Whether there is a failed payment to tell the household about at all. */
export function isPaymentFailing(subscription: SubscriptionState | null | undefined): boolean {
  return paymentFailureStage(subscription) !== null;
}

/** Whether the failed payment has already cost the household its paid caps. */
export function isPaymentLapsed(subscription: SubscriptionState | null | undefined): boolean {
  return paymentFailureStage(subscription) === 'lapsed';
}

const RANK: Record<PlanId, number> = { seedling: 0, garden: 1, greenhouse: 2 };

/**
 * The tier whose caps a LAPSED household actually has.
 *
 * Mirrors the server's `getEntitledPlan` for a non-entitled status: the
 * subscription falls to Seedling, but two things sit underneath that and
 * cannot be taken away by a declined card — a tier bought outright
 * (`withLifetimeFloor`) and a running gift (`withGift`). The no-card trial
 * does not apply: a household with Stripe state never has one.
 *
 * Only meaningful for the `lapsed` stage; a `retrying` household keeps the
 * plan it is on.
 */
export function planWhilePaymentFails(subscription: SubscriptionState | null | undefined): PlanId {
  let plan: PlanId = 'seedling';
  const lifetime = subscription?.lifetimePlanId;
  if (lifetime && (RANK[lifetime] ?? 0) > RANK[plan]) plan = lifetime;
  const gift = subscription?.gift;
  if (gift?.state === 'active' && (RANK[gift.planId] ?? 0) > RANK[plan]) plan = gift.planId;
  return plan;
}

export interface PaymentFailedCopy {
  titleKey: string;
  bodyKey: string;
  values: Record<string, string>;
}

/**
 * The title and "what changed" sentence for a failed payment, or `null` when
 * there is none.
 *
 * `retrying` says what is true while Stripe retries: the plan is kept and
 * nothing has changed yet, and the card needs updating to keep it. It names
 * the plan when the catalog could name it and says "its paid plan" otherwise —
 * never a guessed name. No date is given: when the retries end is Stripe's
 * dunning schedule, which this app does not read.
 *
 * `lapsed` names the free plan only when that is what the household keeps; a
 * tier bought outright or a running gift gets a sentence that does not.
 */
export function paymentFailedCopy(
  subscription: SubscriptionState | null | undefined,
  planName: string | null | undefined
): PaymentFailedCopy | null {
  const stage = paymentFailureStage(subscription);
  if (stage === null) return null;
  if (stage === 'retrying') {
    return planName
      ? {
          titleKey: 'settings.billing.paymentRetryingTitle',
          bodyKey: 'settings.billing.paymentRetryingBody',
          values: { plan: planName },
        }
      : {
          titleKey: 'settings.billing.paymentRetryingTitle',
          bodyKey: 'settings.billing.paymentRetryingBodyNoPlan',
          values: {},
        };
  }
  return {
    titleKey: 'settings.billing.paymentFailedTitle',
    bodyKey:
      planWhilePaymentFails(subscription) === 'seedling'
        ? 'settings.billing.paymentFailedBody'
        : 'settings.billing.paymentFailedBodyOwned',
    values: {},
  };
}
