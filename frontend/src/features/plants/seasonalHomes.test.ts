import { describe, expect, it } from 'vitest';
import type { PlantSpace } from '@/services/plantService';
import { seasonalHomeSuggestion, seasonForMonth } from './seasonalHomes';

const spaces: PlantSpace[] = [
  {
    id: 'patio',
    householdId: 'hh',
    name: 'Patio',
    environment: 'outside',
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  },
  {
    id: 'sunroom',
    householdId: 'hh',
    name: 'Sunroom',
    environment: 'inside',
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  },
];

describe('seasonal homes', () => {
  it('inverts warm and cool seasons across hemispheres', () => {
    expect(seasonForMonth(45, 6)).toBe('summer');
    expect(seasonForMonth(45, 0)).toBe('winter');
    expect(seasonForMonth(-33, 6)).toBe('winter');
    expect(seasonForMonth(-33, 0)).toBe('summer');
  });

  it('suggests the configured home when the plant is elsewhere', () => {
    expect(
      seasonalHomeSuggestion(
        { spaceId: 'sunroom', summerSpaceId: 'patio', winterSpaceId: 'sunroom' },
        spaces,
        45,
        new Date(2026, 6, 15)
      )
    ).toEqual({ season: 'summer', targetSpace: spaces[0] });
  });

  it('does not prompt without a latitude, valid target, or needed move', () => {
    const plant = { spaceId: 'patio', summerSpaceId: 'patio', winterSpaceId: 'missing' };
    expect(seasonalHomeSuggestion(plant, spaces, null, new Date(2026, 6, 15))).toBeNull();
    expect(seasonalHomeSuggestion(plant, spaces, 45, new Date(2026, 6, 15))).toBeNull();
    expect(seasonalHomeSuggestion(plant, spaces, 45, new Date(2026, 0, 15))).toBeNull();
  });
});
