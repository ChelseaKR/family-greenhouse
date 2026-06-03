/**
 * Single source of truth for marketing pricing data. Used by both the
 * LandingPage hash-anchored "#pricing" section and the standalone
 * `/pricing` page so the cards stay in sync. Production billing limits
 * still live server-side (`backend/src/services/billing.ts`); this file
 * is the marketing copy + display name + tagline only.
 */
export interface PricingPlan {
  name: string;
  price: string;
  /** "/month" or undefined for free. */
  period?: string;
  description: string;
  features: string[];
  cta: string;
  /** The middle plan we want to draw the eye to. */
  highlighted: boolean;
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    name: 'Seedling',
    price: 'Free',
    description: 'Perfect for getting started',
    features: ['Up to 10 plants', '1 household member', 'Basic care reminders', 'Mobile access'],
    cta: 'Get Started',
    highlighted: false,
  },
  {
    name: 'Garden',
    price: '$4.99',
    period: '/month',
    description: 'For growing families',
    features: [
      'Unlimited plants',
      'Up to 6 household members',
      'Smart scheduling',
      'Care history & analytics',
      'Photo gallery',
      'Priority support',
    ],
    cta: 'Start Free Trial',
    highlighted: true,
  },
  {
    name: 'Greenhouse',
    price: '$9.99',
    period: '/month',
    description: 'For serious plant parents',
    features: [
      'Everything in Garden',
      'Unlimited household members',
      'Plant health insights',
      'Custom care schedules',
      'API access',
    ],
    cta: 'Start Free Trial',
    highlighted: false,
  },
];
