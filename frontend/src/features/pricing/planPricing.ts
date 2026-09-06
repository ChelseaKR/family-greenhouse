import type { TFunction } from 'i18next';
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

/**
 * The tier's "homes · hands · plants" line (ADR 0014).
 *
 * Three-state, like everything else that reads a cap off the wire: a number
 * is the ceiling, `null` is unlimited and gets its own words, and `undefined`
 * — an older backend that never sent the field — is simply not stated. The
 * one thing this must never do is push a null through a numeric path, which
 * would print "0 members": a cap of nothing, the exact opposite of no cap.
 */
export function capsLine(plan: Plan, t: TFunction): string {
  // `limits` when the backend sends it, the legacy fields otherwise. NOT
  // `plan.limits?.members ?? plan.maxMembers`: `null ?? x` yields x, so an
  // unlimited cap would silently fall through to whatever the legacy field
  // happened to hold and print a ceiling that does not exist.
  const members = plan.limits ? plan.limits.members : plan.maxMembers;
  const plants = plan.limits ? plan.limits.plants : plan.maxPlants;
  const parts: string[] = [];
  const homes = plan.limits?.homes;
  if (homes === null) parts.push(t('pricing.capHomesUnlimited'));
  else if (typeof homes === 'number')
    parts.push(homes === 1 ? t('pricing.capHomesOne') : t('pricing.capHomes', { count: homes }));
  if (members === null) parts.push(t('pricing.capMembersUnlimited'));
  else if (typeof members === 'number')
    parts.push(t('pricing.capMembers', { count: members.toLocaleString() }));
  if (plants === null) parts.push(t('pricing.capPlantsUnlimited'));
  else if (typeof plants === 'number')
    parts.push(t('pricing.capPlants', { count: plants.toLocaleString() }));
  return parts.join(' · ');
}
