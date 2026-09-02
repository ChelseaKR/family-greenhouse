import type { BillingInterval, Plan } from '@/services/billingService';

/**
 * Amount for a tier at one cadence, or null when that cadence is not sold.
 *
 * `null` is a first-class answer and must never collapse to 0. Two different
 * situations produce it, and both mean "do not offer this":
 *
 *   - the tier genuinely has no such option (the free tier has no annual
 *     price; Greenhouse has no lifetime price), or
 *   - the server withheld every price field because payment activity is
 *     disabled, or that cadence's Stripe price id is blank — a deliberate
 *     partial launch, see environments/*.tfvars.
 *
 * Rendering either case as a free plan would advertise a price the API will
 * refuse to honour at checkout.
 */
export function priceFor(plan: Plan, interval: BillingInterval): number | null {
  if (interval === 'lifetime') return plan.lifetimePrice ?? null;
  if (interval === 'year') return plan.annualPrice ?? null;
  return plan.monthlyPrice ?? null;
}

/** True when at least one paid tier sells this cadence, so the interval
 *  toggle can hide options that would render an all-unavailable grid. */
export function intervalIsOffered(plans: Plan[], interval: BillingInterval): boolean {
  return plans.some((plan) => plan.id !== 'seedling' && priceFor(plan, interval) !== null);
}
