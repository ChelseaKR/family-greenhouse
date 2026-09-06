/**
 * Plan feature switches. Kept in its own file (rather than appended to
 * plans.test.ts) because `plans.ts` is being restructured in parallel and this
 * is the one thing the caretaker-seat gate depends on.
 */
import { describe, it, expect } from 'vitest';
import { PLANS, planHasFeature } from '../../../src/models/plans.js';

describe('plan features', () => {
  it('puts caretaker seats on Greenhouse only', () => {
    expect(PLANS.seedling.features.caretakerSeats).toBe(false);
    expect(PLANS.garden.features.caretakerSeats).toBe(false);
    expect(PLANS.greenhouse.features.caretakerSeats).toBe(true);
  });

  it('resolves a feature from a plan id', () => {
    expect(planHasFeature('greenhouse', 'caretakerSeats')).toBe(true);
    expect(planHasFeature('garden', 'caretakerSeats')).toBe(false);
  });

  it('falls back to the free tier for unknown, missing or inherited ids', () => {
    // A corrupt or absent billing row must never open a paid feature, and
    // `Object.hasOwn` (not `in`) is what stops 'toString' resolving to a plan.
    expect(planHasFeature(undefined, 'caretakerSeats')).toBe(false);
    expect(planHasFeature(null, 'caretakerSeats')).toBe(false);
    expect(planHasFeature('enterprise', 'caretakerSeats')).toBe(false);
    expect(planHasFeature('toString', 'caretakerSeats')).toBe(false);
  });

  it('gives every plan an explicit answer for every feature', () => {
    // A tier that simply omits a switch would read as `undefined` — falsy by
    // luck rather than by decision. Every plan states every feature.
    for (const plan of Object.values(PLANS)) {
      for (const value of Object.values(plan.features)) {
        expect(typeof value).toBe('boolean');
      }
      expect(Object.keys(plan.features)).toEqual(Object.keys(PLANS.seedling.features));
    }
  });
});
