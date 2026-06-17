import { describe, it, expect } from 'vitest';
import { PLANS, getPlan, isPlanId } from '../../../src/models/plans.js';

describe('plan catalog', () => {
  it('exposes exactly the three known tiers', () => {
    expect(Object.keys(PLANS).sort()).toEqual(['garden', 'greenhouse', 'seedling']);
  });

  it('pins the per-tier caps the handlers enforce', () => {
    expect(PLANS.seedling).toMatchObject({ monthlyPrice: 0, maxPlants: 10, maxMembers: 6 });
    expect(PLANS.garden).toMatchObject({ monthlyPrice: 4.99, maxPlants: 500, maxMembers: 6 });
    expect(PLANS.greenhouse).toMatchObject({ monthlyPrice: 9.99, maxPlants: 5000, maxMembers: 50 });
  });

  it('only paid tiers carry a Stripe price env var; free tier has none', () => {
    expect(PLANS.seedling.stripePriceEnv).toBeUndefined();
    expect(PLANS.garden.stripePriceEnv).toBe('STRIPE_PRICE_ID_GARDEN');
    expect(PLANS.greenhouse.stripePriceEnv).toBe('STRIPE_PRICE_ID_GREENHOUSE');
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
