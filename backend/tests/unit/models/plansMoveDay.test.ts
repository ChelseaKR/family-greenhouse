import { describe, expect, it } from 'vitest';
import { PLANS, getPlan, planHasMoveDay } from '../../../src/models/plans.js';

// Seasonal Move Day (ideation brief §4.9) is a Garden+ entitlement. One
// boolean per tier + one accessor; the handler consults nothing else.
describe('plan catalog: Seasonal Move Day', () => {
  it('is off on the free tier and on for both paid tiers', () => {
    expect(PLANS.seedling.moveDay).toBe(false);
    expect(PLANS.garden.moveDay).toBe(true);
    expect(PLANS.greenhouse.moveDay).toBe(true);
  });

  it('planHasMoveDay reads the tier flag', () => {
    expect(planHasMoveDay(getPlan('seedling'))).toBe(false);
    expect(planHasMoveDay(getPlan('garden'))).toBe(true);
    expect(planHasMoveDay(getPlan('greenhouse'))).toBe(true);
  });

  it('an unknown or missing plan resolves to the free tier, which is locked', () => {
    expect(planHasMoveDay(getPlan(undefined))).toBe(false);
    expect(planHasMoveDay(getPlan('toString'))).toBe(false);
  });
});
