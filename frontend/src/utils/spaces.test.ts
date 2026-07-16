import { describe, expect, it } from 'vitest';
import type { Plant, PlantSpace } from '@/services/plantService';
import { matchesSpaceFilter, plantLocationLabel, spaceMap } from './spaces';

const spaces: PlantSpace[] = [
  {
    id: 'inside',
    householdId: 'hh',
    name: 'Kitchen',
    environment: 'inside',
    createdAt: '',
    createdBy: 'u',
    updatedAt: '',
  },
  {
    id: 'outside',
    householdId: 'hh',
    name: 'Patio',
    environment: 'outside',
    createdAt: '',
    createdBy: 'u',
    updatedAt: '',
  },
];

const plant = (input: Partial<Plant>): Plant => ({
  id: 'p',
  householdId: 'hh',
  name: 'Fern',
  species: null,
  location: null,
  imageUrl: null,
  notes: null,
  createdAt: '',
  createdBy: 'u',
  updatedAt: '',
  ...input,
});

describe('space utilities', () => {
  it('uses a structured space and placement note for the display label', () => {
    expect(
      plantLocationLabel(
        plant({ spaceId: 'inside', placementNote: 'east window' }),
        spaceMap(spaces)
      )
    ).toBe('Kitchen · east window');
  });

  it('falls back to a legacy location before Unplaced', () => {
    expect(plantLocationLabel(plant({ location: 'Old room' }), spaceMap(spaces))).toBe('Old room');
    expect(plantLocationLabel(plant({}), spaceMap(spaces))).toBe('Unplaced');
  });

  it('filters by the current space environment', () => {
    const lookup = spaceMap(spaces);
    expect(matchesSpaceFilter(plant({ spaceId: 'outside' }), lookup, 'outside')).toBe(true);
    expect(matchesSpaceFilter(plant({ spaceId: 'outside' }), lookup, 'inside')).toBe(false);
    expect(matchesSpaceFilter(plant({}), lookup, 'unplaced')).toBe(true);
  });
});
