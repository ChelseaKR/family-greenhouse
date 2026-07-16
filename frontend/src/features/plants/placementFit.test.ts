import { describe, expect, it } from 'vitest';
import type { PlantSpace } from '@/services/plantService';
import { minimumLightFromSunlight, placementFitChecks } from './placementFit';

const space = (overrides: Partial<PlantSpace> = {}): PlantSpace => ({
  id: 'space-1',
  householdId: 'hh',
  name: 'Bathroom',
  environment: 'inside',
  rainExposure: 'sheltered',
  lightLevel: null,
  petAccess: null,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  ...overrides,
});

describe('placementFitChecks', () => {
  it('does not turn unknown space or care data into a warning', () => {
    expect(placementFitChecks(space(), {})).toEqual([]);
    expect(placementFitChecks(undefined, { minimumLight: 'bright', toxicToPets: true })).toEqual(
      []
    );
  });

  it('warns only when recorded light is below the tolerated minimum', () => {
    expect(placementFitChecks(space({ lightLevel: 'low' }), { minimumLight: 'medium' })).toEqual([
      { type: 'light', current: 'low', recommended: 'medium' },
    ]);
    expect(placementFitChecks(space({ lightLevel: 'bright' }), { minimumLight: 'medium' })).toEqual(
      []
    );
  });

  it('warns about toxicity only in a space explicitly accessible to pets', () => {
    expect(placementFitChecks(space({ petAccess: true }), { toxicToPets: true })).toEqual([
      { type: 'pet' },
    ]);
    expect(placementFitChecks(space({ petAccess: false }), { toxicToPets: true })).toEqual([]);
    expect(placementFitChecks(space({ petAccess: true }), { toxicToPets: null })).toEqual([]);
  });
});

describe('minimumLightFromSunlight', () => {
  it('uses the lowest explicitly tolerated broad light band', () => {
    expect(minimumLightFromSunlight(['full sun'])).toBe('bright');
    expect(minimumLightFromSunlight(['full sun', 'part shade'])).toBe('medium');
    expect(minimumLightFromSunlight(['low light', 'bright indirect'])).toBe('low');
    expect(minimumLightFromSunlight([])).toBeNull();
    expect(minimumLightFromSunlight(['unknown'])).toBeNull();
  });
});
