/**
 * Plan gate for Plant Tags (ADR 0016): Seedling none, Garden 50, Greenhouse
 * unlimited — and the accessor publishes "unlimited" as null, not Infinity,
 * because Infinity does not survive JSON.
 */
import { describe, expect, it } from 'vitest';
import { PLANS, getPlan, plantTagAllowance } from '../../../src/models/plans.js';

describe('plantTagAllowance', () => {
  it('Seedling has no plant tags', () => {
    expect(PLANS.seedling.features.plantTags).toBe(false);
    expect(PLANS.seedling.limits.tags).toBe(0);
    expect(plantTagAllowance(PLANS.seedling)).toEqual({ enabled: false, max: 0 });
  });

  it('Garden gets up to 50 active tags', () => {
    expect(plantTagAllowance(PLANS.garden)).toEqual({ enabled: true, max: 50 });
  });

  it('Greenhouse is unlimited, published as null so it round-trips through JSON', () => {
    const allowance = plantTagAllowance(PLANS.greenhouse);
    expect(allowance).toEqual({ enabled: true, max: null });
    expect(JSON.parse(JSON.stringify(allowance))).toEqual({ enabled: true, max: null });
  });

  it('an unknown plan id falls back to Seedling (no tags)', () => {
    expect(plantTagAllowance(getPlan('enterprise'))).toEqual({ enabled: false, max: 0 });
  });
});
