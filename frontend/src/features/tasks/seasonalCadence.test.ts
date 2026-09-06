import { describe, expect, it } from 'vitest';
import {
  SEASONS,
  hemisphereForLatitude,
  nextCadenceChange,
  resolveCadence,
  seasonForMonth,
  type Season,
  type SeasonalCadence,
} from './seasonalCadence';

const SEVEN_FOURTEEN: SeasonalCadence[] = [
  { season: 'spring', frequency: 7 },
  { season: 'summer', frequency: 7 },
  { season: 'autumn', frequency: 14 },
  { season: 'winter', frequency: 14 },
];

const at = (year: number, monthIndex: number, day: number) =>
  new Date(year, monthIndex, day, 12, 0, 0, 0);

describe('seasonForMonth', () => {
  const northern: Season[] = [
    'winter',
    'winter',
    'spring',
    'spring',
    'spring',
    'summer',
    'summer',
    'summer',
    'autumn',
    'autumn',
    'autumn',
    'winter',
  ];

  it('maps every month in the north', () => {
    northern.forEach((season, monthIndex) => {
      expect(seasonForMonth('north', monthIndex)).toBe(season);
    });
  });

  it('maps the south six months out of phase', () => {
    for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
      expect(seasonForMonth('south', monthIndex)).toBe(northern[(monthIndex + 6) % 12]);
    }
  });
});

describe('hemisphereForLatitude', () => {
  it('splits at the equator and reads a missing latitude as unknown', () => {
    expect(hemisphereForLatitude(52.52)).toBe('north');
    expect(hemisphereForLatitude(-37.81)).toBe('south');
    expect(hemisphereForLatitude(0)).toBe('north');
    expect(hemisphereForLatitude(null)).toBeNull();
    expect(hemisphereForLatitude(undefined)).toBeNull();
    expect(hemisphereForLatitude(Number.NaN)).toBeNull();
  });
});

describe('resolveCadence', () => {
  it('gives the dormant cadence in November and the growing one in May', () => {
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, 10, 15)).frequency).toBe(14);
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, 4, 15)).frequency).toBe(7);
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'south', at(2026, 10, 15)).frequency).toBe(7);
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'south', at(2026, 4, 15)).frequency).toBe(14);
  });

  it('reports no_location rather than assuming a hemisphere', () => {
    // The chip's whole job on this branch is to say "seasons unavailable — set
    // a location". Defaulting to north would render a number nobody chose.
    expect(resolveCadence(9, SEVEN_FOURTEEN, null, at(2026, 10, 15))).toEqual({
      frequency: 9,
      source: 'base',
      season: null,
      reason: 'no_location',
    });
  });

  it('reports no_profile for a task with no seasonal cadences', () => {
    expect(resolveCadence(9, null, 'north', at(2026, 10, 15)).reason).toBe('no_profile');
    expect(resolveCadence(9, [], 'north', at(2026, 10, 15)).reason).toBe('no_profile');
  });

  it('names the season even when that season has no cadence', () => {
    const winterOnly: SeasonalCadence[] = [{ season: 'winter', frequency: 21 }];
    expect(resolveCadence(9, winterOnly, 'north', at(2026, 10, 15))).toEqual({
      frequency: 9,
      source: 'base',
      season: 'autumn',
      reason: 'season_unset',
    });
  });
});

describe('nextCadenceChange', () => {
  it('counts down to the next change in the number', () => {
    expect(nextCadenceChange(9, SEVEN_FOURTEEN, 'north', at(2026, 10, 15))).toEqual(
      new Date(2027, 2, 1, 0, 0, 0, 0)
    );
    expect(nextCadenceChange(9, SEVEN_FOURTEEN, 'north', at(2026, 4, 15))).toEqual(
      new Date(2026, 8, 1, 0, 0, 0, 0)
    );
  });

  it('returns null when nothing changes, or when there is nothing to change', () => {
    const flat: SeasonalCadence[] = SEASONS.map((season) => ({ season, frequency: 10 }));
    expect(nextCadenceChange(9, flat, 'north', at(2026, 4, 15))).toBeNull();
    expect(nextCadenceChange(9, SEVEN_FOURTEEN, null, at(2026, 4, 15))).toBeNull();
    expect(nextCadenceChange(9, null, 'north', at(2026, 4, 15))).toBeNull();
  });
});
