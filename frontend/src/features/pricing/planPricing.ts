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
 * What one tier's card shows, and sells, under the selected toggle tab.
 *
 * On the Yearly tab a paid tier with no yearly price but a monthly one shows
 * that monthly price, marked "billed monthly" (ADR 0042, "Yearly first"):
 * Yearly is the tab a household lands on, and Greenhouse has no yearly
 * cadence. The returned `interval` is the cadence the amount belongs to, and
 * it is what the card's checkout must send, so the price on the card and the
 * price charged cannot differ. A tier with neither price stays `null`
 * (unavailable), and so does any other tab: Lifetime never borrows a monthly.
 */
export function cadenceShown(
  plan: Plan,
  selected: BillingInterval
): { interval: BillingInterval; price: number | null } {
  const price = priceFor(plan, selected);
  if (price !== null || selected !== 'year' || plan.id === 'seedling') {
    return { interval: selected, price };
  }
  const monthly = priceFor(plan, 'month');
  return monthly === null ? { interval: selected, price } : { interval: 'month', price: monthly };
}

/**
 * The cadence the toggle opens on (ADR 0042, "Yearly first"): yearly, when
 * any paid tier sells it. Every rival app leads with its yearly price, the
 * yearly Garden price is the lowest in that set, and a yearly charge hands
 * Stripe about 4% of the year's revenue where twelve monthly charges hand it
 * about 13%. Monthly stays one tap away.
 */
export const DEFAULT_INTERVAL: BillingInterval = 'year';

/**
 * The cadence the person last tapped, kept in module memory for this page
 * load only. It is not storage: nothing is written to localStorage,
 * sessionStorage or a cookie, nothing is sent anywhere, and a reload returns
 * to the default. The pricing page and Plan status share it, so a household
 * that chose "Monthly" on one is not shown "Yearly" again on the other a
 * moment later.
 */
let rememberedInterval: BillingInterval | null = null;

export function rememberInterval(interval: BillingInterval): void {
  rememberedInterval = interval;
}

/** Test-only: forget the tapped cadence between tests, which share the module. */
export function resetRememberedIntervalForTests(): void {
  rememberedInterval = null;
}

/**
 * The cadence to show first, given the ones on sale, in order of preference:
 * the one the person tapped earlier this visit, then the yearly default, then
 * the first cadence actually offered, so a monthly-only launch does not open
 * on an empty "Yearly" tab. `offered` is the toggle's own order.
 */
export function initialInterval(offered: readonly BillingInterval[]): BillingInterval {
  if (rememberedInterval !== null && offered.includes(rememberedInterval)) {
    return rememberedInterval;
  }
  if (offered.includes(DEFAULT_INTERVAL)) return DEFAULT_INTERVAL;
  return offered[0] ?? 'month';
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

/**
 * The yearly toggle's "Save ~N%" figure, derived from the first paid tier
 * that publishes both a monthly and a yearly price: one minus the yearly
 * amount over twelve monthly ones, rounded. Computed rather than typed so a
 * repricing (ADR 0042 took Garden from a 33% to a 30% saving) cannot leave
 * the hint stating a discount the amounts beside it contradict. `null` when
 * no tier offers both, in which case the hint is not rendered at all.
 */
export function annualSavingPercent(plans: Plan[]): number | null {
  for (const plan of plans) {
    if (plan.id === 'seedling') continue;
    const monthly = priceFor(plan, 'month');
    const yearly = priceFor(plan, 'year');
    if (monthly === null || yearly === null || monthly <= 0) continue;
    return Math.round((1 - yearly / (monthly * 12)) * 100);
  }
  return null;
}
