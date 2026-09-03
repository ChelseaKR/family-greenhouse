/**
 * Source-of-truth subscription plan catalog. Each tier names its caps so the
 * handlers can enforce them without hardcoding numbers, and lists the Stripe
 * price ID it maps to (read at runtime from env so staging/prod keys stay
 * separate). Free tier has no Stripe price.
 */
export type PlanId = 'seedling' | 'garden' | 'greenhouse';

/**
 * Billing cadence. The same `planId` (and therefore the same caps and
 * entitlements) is sold at each cadence — only the Stripe price and the
 * headline number differ — so the whole webhook/entitlement path stays
 * cadence-agnostic and resolves access off `planId` alone.
 *
 * `lifetime` is a one-time payment (Stripe `mode:'payment'`) rather than a
 * recurring subscription: it grants the same `planId` permanently with no
 * subscription to renew or cancel.
 */
export type BillingInterval = 'month' | 'year' | 'lifetime';

/** Per-tier caps on features that are gated by number rather than on/off. */
export interface PlanLimits {
  /** Longest sitter-link coverage window, in days (ADR 0015). */
  sitterLinkMaxDays: number;
  /** How many sitter links may be live (active or scheduled) at once. */
  sitterLinksActive: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  monthlyPrice: number; // dollars
  maxPlants: number;
  maxMembers: number;
  limits: PlanLimits;
  /** Env var name where the Stripe MONTHLY price ID lives. Read at runtime so
   *  staging/prod keys stay separate. Free tier has none. */
  stripePriceEnv?: string;
  /** Annual price in dollars/year (a discount vs 12× monthly). Undefined on the
   *  free tier. Present on every paid tier because households already on an
   *  annual subscription keep renewing at it; whether a NEW one may be started
   *  is `withdrawnIntervals`, not this field. */
  annualPrice?: number;
  /** Env var name where the Stripe ANNUAL price ID lives. Paired with
   *  `annualPrice`; absent on the free tier. */
  annualStripePriceEnv?: string;
  /** Lifetime price in dollars for a one-time payment that grants this tier's
   *  entitlement permanently. Modeled as a one-time billing interval on the
   *  existing tier (NOT a new planId), so entitlement resolution and the
   *  3-plan catalog stay unchanged. Only the Garden tier has one. */
  lifetimePrice?: number;
  /** Env var name where the Stripe LIFETIME (one-time) price ID lives. Paired
   *  with `lifetimePrice`; absent on tiers without a lifetime option. */
  lifetimeStripePriceEnv?: string;
  /**
   * Cadences that EXIST on this tier but may no longer be STARTED.
   *
   * Withdrawal is an availability decision, not a deletion. The price and its
   * Stripe env stay on the plan so that (a) the webhook can still resolve a
   * renewing annual/lifetime price id back to its tier, (b) the billing
   * portal keeps managing the subscriptions already on it, and (c)
   * entitlement — which reads `planId` alone — is untouched. What changes is
   * the OFFER: `planSummary` publishes `null` for a withdrawn cadence, which
   * the client already renders as "not available", and checkout refuses it
   * (`isIntervalOffered`). Stripe prices are never archived for this; the
   * subscriptions on them must keep renewing.
   *
   * Withdrawn 2026-09-02: at the verified per-ID cost the AI-cost ceiling
   * per household ($3.48 Garden, $7.58 Greenhouse) exceeds what an annual
   * subscription earns per month ($3.33 / $6.67), and a $149 lifetime
   * purchase is fully consumed after roughly 41 months. Monthly remains.
   */
  withdrawnIntervals?: readonly BillingInterval[];
}

export const PLANS: Record<PlanId, Plan> = {
  seedling: {
    id: 'seedling',
    name: 'Seedling',
    description: 'Free, perfect for getting started',
    monthlyPrice: 0,
    maxPlants: 10,
    maxMembers: 6,
    // One live sitter link, a week long: the task list for a weekend away.
    limits: { sitterLinkMaxDays: 7, sitterLinksActive: 1 },
  },
  garden: {
    id: 'garden',
    name: 'Garden',
    description: 'For growing families',
    monthlyPrice: 4.99,
    // ~33% off 12× monthly ($59.88) — "$3.33/mo billed yearly". Sits in the
    // competitive annual band ($30–48) the market actually pays at.
    annualPrice: 39.99,
    // One-time payment that grants Garden permanently. Stored as planId='garden'
    // with no subscription — entitlement resolves off planId alone.
    lifetimePrice: 149,
    maxPlants: 500,
    maxMembers: 6,
    // The Away Kit: windows to 90 days, several sitters at once.
    limits: { sitterLinkMaxDays: 90, sitterLinksActive: 10 },
    stripePriceEnv: 'STRIPE_PRICE_ID_GARDEN',
    annualStripePriceEnv: 'STRIPE_PRICE_ID_GARDEN_ANNUAL',
    lifetimeStripePriceEnv: 'STRIPE_PRICE_ID_GARDEN_LIFETIME',
    // Annual ($3.33/mo) and lifetime ($149 once) both earn less per month
    // than the tier's $3.48 AI-cost ceiling. Existing subscribers keep them.
    withdrawnIntervals: ['year', 'lifetime'],
  },
  greenhouse: {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: 'For serious plant parents',
    monthlyPrice: 9.99,
    // ~33% off 12× monthly ($119.88) — "$6.67/mo billed yearly".
    annualPrice: 79.99,
    maxPlants: 5000,
    maxMembers: 50,
    limits: { sitterLinkMaxDays: 90, sitterLinksActive: 25 },
    stripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE',
    annualStripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE_ANNUAL',
    // Annual ($6.67/mo) earns less per month than the tier's $7.58 AI-cost
    // ceiling. Existing subscribers keep it.
    withdrawnIntervals: ['year'],
  },
};

export function getPlan(id: string | undefined | null): Plan {
  // Object.hasOwn (not `in`): `in` also matches inherited prototype
  // properties, so e.g. getPlan('toString') would return undefined and crash
  // the caller instead of falling back to the free tier.
  if (id && Object.hasOwn(PLANS, id)) return PLANS[id as PlanId];
  return PLANS.seedling;
}

/** Numeric caps for a tier; unknown ids fall back to the free tier's. */
export function planLimits(id: string | undefined | null): PlanLimits {
  return getPlan(id).limits;
}

/**
 * Tiers in ascending entitlement order. Used to compare what a household
 * already owns against what it is trying to buy — a lifetime purchase is an
 * entitlement FLOOR, so a tier at or below it must never be sold again.
 */
export const PLAN_ORDER: readonly PlanId[] = ['seedling', 'garden', 'greenhouse'];

/** Rank of a tier in PLAN_ORDER; higher means strictly more entitlement. */
export function planRank(id: PlanId): number {
  return PLAN_ORDER.indexOf(id);
}

/** True iff `id` names a real plan in the catalog. */
export function isPlanId(id: unknown): id is PlanId {
  return typeof id === 'string' && Object.hasOwn(PLANS, id);
}

/** True when this cadence exists on the tier but has been withdrawn from sale. */
export function isIntervalWithdrawn(plan: Plan, interval: BillingInterval): boolean {
  return plan.withdrawnIntervals?.includes(interval) ?? false;
}

/** Amount for a tier at one cadence, or undefined when the tier has no such cadence. */
function priceAt(plan: Plan, interval: BillingInterval): number | undefined {
  if (interval === 'lifetime') return plan.lifetimePrice;
  if (interval === 'year') return plan.annualPrice;
  return plan.monthlyPrice;
}

/**
 * True when a household may START this cadence today: the tier has a price
 * at it AND that cadence has not been withdrawn. This is the single authority
 * checkout consults, and `planSummary` publishes the same answer as a null
 * price — so a current client never shows an option the API would refuse,
 * and a stale or crafted request is refused on the same rule.
 */
export function isIntervalOffered(plan: Plan, interval: BillingInterval): boolean {
  return priceAt(plan, interval) !== undefined && !isIntervalWithdrawn(plan, interval);
}

export interface PlanSummary {
  id: PlanId;
  name: string;
  description: string;
  maxPlants: number;
  maxMembers: number;
  monthlyPrice?: number;
  annualPrice?: number | null;
  lifetimePrice?: number | null;
}

/**
 * Public, client-facing projection of a plan. Price fields are fail-closed:
 * callers must explicitly prove that payments are available before including
 * them. The API and local server pass their commercial-status decision here,
 * while internal tests can still exercise the retained historical billing
 * implementation without publishing amounts.
 */
export function planSummary(plan: Plan, includePrices = false): PlanSummary {
  const summary: PlanSummary = {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    maxPlants: plan.maxPlants,
    maxMembers: plan.maxMembers,
  };

  if (includePrices) {
    summary.monthlyPrice = plan.monthlyPrice;
    // null (not undefined) survives JSON serialization as an explicit
    // "no annual option" signal when payment activity is enabled. A WITHDRAWN
    // cadence publishes as null too — the same "not sold at this cadence"
    // signal the client already renders as "not available" — so a tier keeps
    // its annual/lifetime price for the households already on it without the
    // page offering it to new ones.
    summary.annualPrice = isIntervalOffered(plan, 'year') ? (plan.annualPrice ?? null) : null;
    summary.lifetimePrice = isIntervalOffered(plan, 'lifetime')
      ? (plan.lifetimePrice ?? null)
      : null;
  }

  return summary;
}
