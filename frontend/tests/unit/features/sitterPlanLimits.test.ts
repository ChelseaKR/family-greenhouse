import { describe, expect, it } from 'vitest';
import {
  SITTER_LINK_MAX_DAYS_CEILING,
  sitterLinkLimitsFor,
} from '@/features/household/sitterPlanLimits';

describe('sitterLinkLimitsFor — mirrors backend plans.ts limits', () => {
  it('free keeps one 7-day link; paid tiers get 90 days and several links', () => {
    expect(sitterLinkLimitsFor('seedling')).toEqual({
      planId: 'seedling',
      maxDays: 7,
      maxActive: 1,
    });
    expect(sitterLinkLimitsFor('garden')).toEqual({ planId: 'garden', maxDays: 90, maxActive: 10 });
    expect(sitterLinkLimitsFor('greenhouse')).toEqual({
      planId: 'greenhouse',
      maxDays: 90,
      maxActive: 25,
    });
  });

  it('returns null — unknown, not free and not unlimited — for an id this build does not know', () => {
    expect(sitterLinkLimitsFor(undefined)).toBeNull();
    expect(sitterLinkLimitsFor(null)).toBeNull();
    expect(sitterLinkLimitsFor('')).toBeNull();
    expect(sitterLinkLimitsFor('orchard')).toBeNull();
    // Prototype names must not resolve to a plan either.
    expect(sitterLinkLimitsFor('toString')).toBeNull();
  });

  it('no plan exceeds the schema ceiling the input is bounded by', () => {
    for (const id of ['seedling', 'garden', 'greenhouse']) {
      expect(sitterLinkLimitsFor(id)!.maxDays).toBeLessThanOrEqual(SITTER_LINK_MAX_DAYS_CEILING);
    }
  });
});
