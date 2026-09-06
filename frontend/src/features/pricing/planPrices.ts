import type { BillingInterval, PlanId } from '@/services/billingService';

/**
 * What each tier costs, at each cadence.
 *
 * This MIRRORS `backend/src/models/plans.ts` — `name`, `monthlyPrice`,
 * `annualPrice`, `lifetimePrice` and `withdrawnIntervals`. The backend is the
 * authority: it is what checkout charges, and `planSummary` withholds every
 * price field until payment activity is actually available, so the grid on
 * /pricing keeps rendering the amounts the API publishes at runtime rather
 * than these. Nothing a person reads on the page comes from this table.
 *
 * It exists for the one surface that has to state an amount before any request
 * resolves: the /pricing structured data, which `scripts/prerender.mjs` writes
 * into the static HTML at build time for crawlers that never run the catalog
 * fetch. There is no other frontend copy of the prices, and inventing one is
 * exactly how a public surface goes stale — the social card and the PWA
 * manifest were still advertising a 10-plant free tier seven weeks after it
 * became 20 (#643). A stale number here is worse than either: it is a price in
 * Google's results that checkout will not honour.
 *
 * So keep the two in step. `tests/unit/features/planPrices.test.ts` parses the
 * backend catalog off disk and fails when they disagree, naming the tier and
 * the field that drifted.
 */
export interface PlanPrice {
  id: PlanId;
  /** The tier's catalog name, mirrored so an Offer can be labelled with it. */
  name: string;
  /** Dollars per month. `0` on the free tier is a real price, not "unset". */
  monthly: number;
  /** Dollars per year, or null when the tier has no annual option. */
  annual: number | null;
  /** One-time dollars for a permanent grant, or null when the tier has none. */
  lifetime: number | null;
  /**
   * Cadences this tier still HAS but no longer SELLS (ADR 0012). Mirrored
   * because a withdrawn cadence must never be advertised: `planSummary`
   * publishes its price as null and checkout refuses it (`isIntervalOffered`),
   * so an Offer naming it would promise a purchase the API declines.
   */
  withdrawn: readonly BillingInterval[];
}

export const PLAN_PRICES: readonly PlanPrice[] = [
  { id: 'seedling', name: 'Seedling', monthly: 0, annual: null, lifetime: null, withdrawn: [] },
  {
    id: 'garden',
    name: 'Garden',
    monthly: 4.99,
    annual: 39.99,
    lifetime: 149,
    withdrawn: ['year', 'lifetime'],
  },
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    monthly: 9.99,
    annual: 79.99,
    lifetime: null,
    withdrawn: ['year'],
  },
];

/** Dollars for one cadence, or null when the tier carries no such price. */
function amountAt(plan: PlanPrice, interval: BillingInterval): number | null {
  if (interval === 'lifetime') return plan.lifetime;
  if (interval === 'year') return plan.annual;
  return plan.monthly;
}

export interface OfferedPrice {
  interval: BillingInterval;
  /** Dollars. `0` is a real amount — the free tier — never "no price". */
  amount: number;
}

/**
 * The cadences a new household may actually start on this tier, with their
 * amounts. Two things are excluded, and both mean "do not offer this": a
 * cadence the tier has no price for, and one the catalog has withdrawn from
 * sale. That is the same answer `isIntervalOffered` gives on the server, so a
 * crawler is told about exactly the purchases checkout would accept.
 */
export function offeredPrices(plan: PlanPrice): OfferedPrice[] {
  const intervals: BillingInterval[] = ['month', 'year', 'lifetime'];
  return intervals.flatMap((interval) => {
    if (plan.withdrawn.includes(interval)) return [];
    const amount = amountAt(plan, interval);
    return amount === null ? [] : [{ interval, amount }];
  });
}
