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
  /** Env var name where the Stripe price ID lives. Read lazily so tests don't need to set it. */
  stripePriceEnv?: string;
}

export const PLANS: Record<PlanId, Plan> = {
  seedling: {
    id: 'seedling',
    name: 'Seedling',
    description: 'Free, perfect for getting started',
    monthlyPrice: 0,
    maxPlants: 10,
    maxMembers: 1,
  },
  garden: {
    id: 'garden',
    name: 'Garden',
    description: 'For growing families',
    monthlyPrice: 4.99,
    maxPlants: 500,
    maxMembers: 6,
    stripePriceEnv: 'STRIPE_PRICE_ID_GARDEN',
  },
  greenhouse: {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: 'For serious plant parents',
    monthlyPrice: 9.99,
    maxPlants: 5000,
    maxMembers: 50,
    stripePriceEnv: 'STRIPE_PRICE_ID_GREENHOUSE',
  },
};

export function getPlan(id: string | undefined | null): Plan {
  if (id && id in PLANS) return PLANS[id as PlanId];
  return PLANS.seedling;
}
