/**
 * Source-of-truth subscription plan catalog. Each tier names its caps so the
 * handlers can enforce them without hardcoding numbers, and lists the Stripe
 * price ID it maps to (read at runtime from env so staging/prod keys stay
 * separate). Free tier has no Stripe price.
 */
export type PlanId = 'seedling' | 'garden' | 'greenhouse';

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  monthlyPrice: number; // dollars
  maxPlants: number;
  maxMembers: number;
  /** Env var name where the Stripe MONTHLY price ID lives. Read at runtime so
   *  staging/prod keys stay separate. Free tier has none. */
  stripePriceEnv?: string;
  /** Annual price in dollars/year (a discount vs 12× monthly). Undefined on the
   *  free tier. The category monetizes primarily on annual plans, and annual
   *  subscriptions retain markedly better than monthly — so every paid tier
   *  offers one. */
  annualPrice?: number;
  /** Env var name where the Stripe ANNUAL price ID lives. Paired with
   *  `annualPrice`; absent on the free tier. */
  annualStripePriceEnv?: string;
}

export const PLANS: Record<PlanId, Plan> = {
  seedling: {
    id: 'seedling',
    name: 'Seedling',
    description: 'Free, perfect for getting started',
    monthlyPrice: 0,
    maxPlants: 10,
    maxMembers: 6,
  },
  garden: {
    id: 'garden',
    name: 'Garden',
    description: 'For growing families',
    monthlyPrice: 4.99,
    // ~33% off 12× monthly ($59.88) — "$3.33/mo billed yearly". Sits in the
    // competitive annual band ($30–48) the market actually pays at.
    annualPrice: 39.99,
    maxPlants: 500,
    maxMembers: 6,
    stripePriceEnv: 'STRIPE_PRICE_ID_GARDEN',
    annualStripePriceEnv: 'STRIPE_PRICE_ID_GARDEN_ANNUAL',
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
    stripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE',
    annualStripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE_ANNUAL',
  },
};

export function getPlan(id: string | undefined | null): Plan {
  // Object.hasOwn (not `in`): `in` also matches inherited prototype
  // properties, so e.g. getPlan('toString') would return undefined and crash
  // the caller instead of falling back to the free tier.
  if (id && Object.hasOwn(PLANS, id)) return PLANS[id as PlanId];
  return PLANS.seedling;
}

/** True iff `id` names a real plan in the catalog. */
export function isPlanId(id: unknown): id is PlanId {
  return typeof id === 'string' && Object.hasOwn(PLANS, id);
}
