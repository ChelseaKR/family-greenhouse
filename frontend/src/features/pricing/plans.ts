/**
 * Single source of truth for marketing pricing data. Used by both the
 * LandingPage hash-anchored "#pricing" section and the standalone
 * `/pricing` page so the cards stay in sync. Production billing limits
 * still live server-side (`backend/src/services/billing.ts`); this file
 * is the marketing copy + display name + tagline only.
 */
/** A price shown at a given billing cadence. */
export interface PricePoint {
  /** Headline figure, e.g. "$4.99" or "$39.99". */
  price: string;
  /** Cadence suffix, e.g. "/month" or "/year". */
  period: string;
  /** Optional sub-line, e.g. "$3.33/mo · save 33%". Annual/lifetime only. */
  note?: string;
}

export interface PricingPlan {
  name: string;
  /** Free tier sets this; paid tiers leave it undefined and use monthly/annual. */
  freeLabel?: string;
  monthly?: PricePoint;
  annual?: PricePoint;
  /** One-time lifetime price. Only the Garden tier offers one; other tiers
   *  leave it undefined and fall back to annual when the Lifetime cadence is
   *  selected. */
  lifetime?: PricePoint;
  description: string;
  features: string[];
  cta: string;
  /** The middle plan we want to draw the eye to. */
  highlighted: boolean;
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    name: 'Seedling',
    freeLabel: 'Free',
    description: 'Start on the windowsill',
    features: [
      'Up to 10 plants',
      'Up to 6 household members',
      'Care reminders',
      'Works on your phone',
    ],
    cta: 'Get started',
    highlighted: false,
  },
  {
    name: 'Garden',
    monthly: { price: '$4.99', period: '/month' },
    annual: { price: '$39.99', period: '/year', note: '$3.33/mo · save 33%' },
    lifetime: { price: '$149', period: 'once', note: 'Pay once · keep Garden forever' },
    description: 'For growing families',
    features: [
      'Unlimited plants',
      'Up to 6 household members',
      'Suggested care schedules',
      'Care history & analytics',
      'Photo gallery',
      'Priority support',
    ],
    cta: 'Start free trial',
    highlighted: true,
  },
  {
    name: 'Greenhouse',
    monthly: { price: '$9.99', period: '/month' },
    annual: { price: '$79.99', period: '/year', note: '$6.67/mo · save 33%' },
    description: 'For serious plant parents',
    features: [
      'Everything in Garden',
      'Unlimited household members',
      'Plant health insights',
      'Custom care schedules',
      'API access',
    ],
    cta: 'Start free trial',
    highlighted: false,
  },
];
