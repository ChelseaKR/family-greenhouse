import type { PlanId, SubscriptionState } from '@/services/billingService';

/**
 * Statuses that mean the subscription EXISTS but is not being paid for — the
 * complement of `ENTITLED_SUBSCRIPTION_STATUSES` in
 * `backend/src/models/plans.ts`, which entitles `active` and `trialing` only.
 *
 * The distinction is invisible without it, and that is the whole reason it
 * exists. `planId` keeps saying `garden` through dunning — Stripe only rewrites
 * it to `seedling` when it finally gives up and deletes the subscription,
 * weeks later — while the server has ALREADY dropped the household's caps
 * (`getEntitledPlan`, #364/#540). The one fact that explains that — the card
 * was declined — has to be said by the app, or the household finds out from a
 * 402 the next time it adds a plant (#593).
 *
 * `paused` is deliberately absent: it is a live subscription Stripe is not
 * billing on purpose, not a failed payment, and it is not something this
 * product can put a household into today. `canceled` is absent too: that is
 * the end of dunning, not a payment the household can still fix.
 *
 * Shared by the Settings → Plan status notice and the app-wide banner so the
 * two can never disagree about whether a payment has failed.
 */
export const UNPAID_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
]);

/**
 * Whether Stripe has reported this household's subscription as unpaid.
 *
 * Reads a status Stripe actually sent. An ABSENT status is never dunning:
 * `checkout.session.completed` records the subscription id before any status
 * is known, and calling that window "your payment failed" would be a worse
 * claim than the silence it replaces. Once the card goes through, Stripe sends
 * `customer.subscription.updated` with `past_due -> active`, the webhook writes
 * the new status, and this returns false — which is what hides every notice.
 */
export function isPaymentFailing(subscription: SubscriptionState | null | undefined): boolean {
  const status = subscription?.status;
  return !!status && UNPAID_SUBSCRIPTION_STATUSES.has(status);
}

const RANK: Record<PlanId, number> = { seedling: 0, garden: 1, greenhouse: 2 };

/**
 * The tier whose caps the household actually has while its payment is failing.
 *
 * Mirrors the server's `getEntitledPlan` for a non-entitled status: the
 * subscription falls to Seedling, but two things sit underneath that and
 * cannot be taken away by a declined card — a tier bought outright
 * (`withLifetimeFloor`) and a running gift (`withGift`). The no-card trial
 * does not apply: a household with Stripe state never has one.
 *
 * Without this, a household that owns Garden outright and let a Greenhouse
 * subscription lapse would be told it now has "the free Seedling plan's
 * limits", which is not what the API enforces.
 */
export function planWhilePaymentFails(subscription: SubscriptionState | null | undefined): PlanId {
  let plan: PlanId = 'seedling';
  const lifetime = subscription?.lifetimePlanId;
  if (lifetime && (RANK[lifetime] ?? 0) > RANK[plan]) plan = lifetime;
  const gift = subscription?.gift;
  if (gift?.state === 'active' && (RANK[gift.planId] ?? 0) > RANK[plan]) plan = gift.planId;
  return plan;
}

/**
 * The catalog key for "what changed", chosen by the tier the household keeps.
 * Seedling gets the sentence that names the free plan; anything above it gets
 * one that does not, because naming the free plan there would be false.
 */
export function paymentFailedBodyKey(subscription: SubscriptionState | null | undefined): string {
  return planWhilePaymentFails(subscription) === 'seedling'
    ? 'settings.billing.paymentFailedBody'
    : 'settings.billing.paymentFailedBodyOwned';
}
