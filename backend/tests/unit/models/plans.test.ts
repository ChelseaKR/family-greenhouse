import { describe, it, expect } from 'vitest';
import {
  PLANS,
  getPlan,
  isPlanId,
  isIntervalOffered,
  isIntervalWithdrawn,
  planSummary,
  type Plan,
} from '../../../src/models/plans.js';

describe('plan catalog', () => {
  it('exposes exactly the three known tiers', () => {
    expect(Object.keys(PLANS).sort()).toEqual(['garden', 'greenhouse', 'seedling']);
  });

  it('pins the per-tier caps the handlers enforce', () => {
    expect(PLANS.seedling).toMatchObject({ monthlyPrice: 0, maxPlants: 10, maxMembers: 6 });
    expect(PLANS.garden).toMatchObject({ monthlyPrice: 4.99, maxPlants: 500, maxMembers: 6 });
    expect(PLANS.greenhouse).toMatchObject({ monthlyPrice: 9.99, maxPlants: 5000, maxMembers: 50 });
  });

  it('pins the sitter-link caps per tier (ADR 0015: free keeps one 7-day link; paid gets 90 days, several)', () => {
    expect(PLANS.seedling.limits).toEqual({ sitterLinkMaxDays: 7, sitterLinksActive: 1 });
    expect(PLANS.garden.limits).toEqual({ sitterLinkMaxDays: 90, sitterLinksActive: 10 });
    expect(PLANS.greenhouse.limits).toEqual({ sitterLinkMaxDays: 90, sitterLinksActive: 25 });
  });

  it('only paid tiers carry a Stripe price env var; free tier has none', () => {
    expect(PLANS.seedling.stripePriceEnv).toBeUndefined();
    expect(PLANS.garden.stripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN');
    expect(PLANS.greenhouse.stripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE');
  });

  it('paid tiers carry an annual price + annual Stripe price env; free tier has neither', () => {
    expect(PLANS.seedling.annualPrice).toBeUndefined();
    expect(PLANS.seedling.annualStripePriceEnv).toBeUndefined();
    expect(PLANS.garden.annualPrice).toBe(39.99);
    expect(PLANS.garden.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_ANNUAL');
    expect(PLANS.greenhouse.annualPrice).toBe(79.99);
    expect(PLANS.greenhouse.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE_ANNUAL');
  });

  it('Garden alone carries a lifetime price + lifetime Stripe price env; other tiers have neither', () => {
    expect(PLANS.garden.lifetimePrice).toBe(149);
    expect(PLANS.garden.lifetimeStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_LIFETIME');
    expect(PLANS.seedling.lifetimePrice).toBeUndefined();
    expect(PLANS.seedling.lifetimeStripePriceEnv).toBeUndefined();
    expect(PLANS.greenhouse.lifetimePrice).toBeUndefined();
    expect(PLANS.greenhouse.lifetimeStripePriceEnv).toBeUndefined();
  });

  it('annual price is a genuine discount vs 12x the monthly price', () => {
    for (const id of ['garden', 'greenhouse'] as const) {
      const plan = PLANS[id];
      expect(plan.annualPrice).toBeDefined();
      expect(plan.annualPrice!).toBeLessThan(plan.monthlyPrice * 12);
    }
  });

  it('every plan id field matches its catalog key', () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.id).toBe(key);
    }
  });
});

describe('getPlan', () => {
  it('returns the named plan for each valid id', () => {
    expect(getPlan('seedling')).toBe(PLANS.seedling);
    expect(getPlan('garden')).toBe(PLANS.garden);
    expect(getPlan('greenhouse')).toBe(PLANS.greenhouse);
  });

  it('falls back to the free tier for undefined, null, and empty string', () => {
    expect(getPlan(undefined)).toBe(PLANS.seedling);
    expect(getPlan(null)).toBe(PLANS.seedling);
    expect(getPlan('')).toBe(PLANS.seedling);
  });

  it('falls back to the free tier for unknown ids', () => {
    expect(getPlan('enterprise')).toBe(PLANS.seedling);
  });

  it("does NOT treat inherited prototype properties as plans ('toString' is not a plan)", () => {
    // Object.hasOwn, not `in`: `'toString' in PLANS` is true via the
    // prototype chain and would return undefined → crash the caller.
    expect(getPlan('toString')).toBe(PLANS.seedling);
    expect(getPlan('hasOwnProperty')).toBe(PLANS.seedling);
    expect(getPlan('constructor')).toBe(PLANS.seedling);
    expect(getPlan('__proto__')).toBe(PLANS.seedling);
  });
});

describe('isPlanId', () => {
  it('accepts exactly the catalog ids', () => {
    expect(isPlanId('seedling')).toBe(true);
    expect(isPlanId('garden')).toBe(true);
    expect(isPlanId('greenhouse')).toBe(true);
  });

  it('rejects unknown strings and prototype property names', () => {
    expect(isPlanId('enterprise')).toBe(false);
    expect(isPlanId('toString')).toBe(false);
    expect(isPlanId('__proto__')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isPlanId(undefined)).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isPlanId(42)).toBe(false);
    expect(isPlanId({ id: 'garden' })).toBe(false);
  });
});

describe('withdrawn cadences (2026-09-02: annual on both paid tiers, Garden lifetime)', () => {
  it('pins exactly which cadences are withdrawn on each tier', () => {
    expect(PLANS.seedling.withdrawnIntervals).toBeUndefined();
    expect(PLANS.garden.withdrawnIntervals).toEqual(['year', 'lifetime']);
    expect(PLANS.greenhouse.withdrawnIntervals).toEqual(['year']);
  });

  it('offers monthly on both paid tiers and nothing else', () => {
    expect(isIntervalOffered(PLANS.garden, 'month')).toBe(true);
    expect(isIntervalOffered(PLANS.greenhouse, 'month')).toBe(true);
    expect(isIntervalOffered(PLANS.garden, 'year')).toBe(false);
    expect(isIntervalOffered(PLANS.garden, 'lifetime')).toBe(false);
    expect(isIntervalOffered(PLANS.greenhouse, 'year')).toBe(false);
    expect(isIntervalOffered(PLANS.greenhouse, 'lifetime')).toBe(false);
  });

  it('distinguishes "withdrawn" from "never existed"', () => {
    // Greenhouse lifetime was never a thing; Garden lifetime was, and is
    // withdrawn. Both are unoffered, but only one is a withdrawal — the
    // difference is what tells the webhook to keep resolving the price.
    expect(isIntervalWithdrawn(PLANS.garden, 'lifetime')).toBe(true);
    expect(isIntervalWithdrawn(PLANS.greenhouse, 'lifetime')).toBe(false);
    expect(isIntervalWithdrawn(PLANS.garden, 'month')).toBe(false);
    expect(isIntervalWithdrawn(PLANS.seedling, 'year')).toBe(false);
  });

  it("keeps every withdrawn cadence's price AND Stripe env on the catalog for existing subscribers", () => {
    // Withdrawal must not delete anything the webhook or the portal needs:
    // planIdFromPriceId maps a renewing annual/lifetime price id back to its
    // tier through these env names, so removing them would drop an existing
    // annual household to the free tier at its next renewal.
    expect(PLANS.garden.annualPrice).toBe(39.99);
    expect(PLANS.garden.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_ANNUAL');
    expect(PLANS.garden.lifetimePrice).toBe(149);
    expect(PLANS.garden.lifetimeStripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN_LIFETIME');
    expect(PLANS.greenhouse.annualPrice).toBe(79.99);
    expect(PLANS.greenhouse.annualStripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE_ANNUAL');
  });

  it('leaves the caps and monthly prices exactly where they were', () => {
    // Entitlement reads planId alone, so an annual or lifetime household
    // resolves to the same tier object with the same caps as before.
    expect(PLANS.garden).toMatchObject({ monthlyPrice: 4.99, maxPlants: 500, maxMembers: 6 });
    expect(PLANS.greenhouse).toMatchObject({ monthlyPrice: 9.99, maxPlants: 5000, maxMembers: 50 });
  });

  it('publishes a withdrawn cadence as null while still publishing monthly', () => {
    expect(planSummary(PLANS.garden, true)).toMatchObject({
      monthlyPrice: 4.99,
      annualPrice: null,
      lifetimePrice: null,
    });
    expect(planSummary(PLANS.greenhouse, true)).toMatchObject({
      monthlyPrice: 9.99,
      annualPrice: null,
      lifetimePrice: null,
    });
  });

  it('is switched by the flag, not by the presence of a price: clearing it re-offers the cadence', () => {
    const reListed: Plan = { ...PLANS.garden, withdrawnIntervals: [] };
    expect(isIntervalOffered(reListed, 'year')).toBe(true);
    expect(isIntervalOffered(reListed, 'lifetime')).toBe(true);
    expect(planSummary(reListed, true)).toMatchObject({ annualPrice: 39.99, lifetimePrice: 149 });
  });

  it('never offers a cadence the tier has no price for, withdrawn or not', () => {
    const noLifetime: Plan = { ...PLANS.greenhouse, withdrawnIntervals: [] };
    expect(isIntervalOffered(noLifetime, 'lifetime')).toBe(false);
  });
});
