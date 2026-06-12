import { describe, it, expect } from 'vitest';
import {
  deriveClimateSignals,
  isDueWithinHours,
  climateSkipSuggestion,
  NO_SIGNALS,
} from '@/features/tasks/climateSignals';
import type { ClimateResponse } from '@/services/climateService';

const NOW = new Date('2026-06-10T12:00:00.000Z');

function climate(overrides: Partial<ClimateResponse['weather'] & object> = {}): ClimateResponse {
  return {
    configured: true,
    location: { city: 'Austin, US', lat: 30.27, lon: -97.74 },
    tips: [],
    weather: {
      observedAt: NOW.toISOString(),
      tempC: 20,
      humidity: 50,
      condition: 'Clouds',
      description: 'overcast',
      forecast: [{ date: '2026-06-10', minC: 12, maxC: 24, humidity: 50 }],
      ...overrides,
    },
  };
}

describe('deriveClimateSignals', () => {
  it('returns no signals without weather data', () => {
    expect(deriveClimateSignals(undefined)).toEqual(NO_SIGNALS);
    expect(deriveClimateSignals({ configured: false, weather: null, tips: [] })).toEqual(
      NO_SIGNALS
    );
  });

  it('flags rain for rain/storm conditions (same thresholds as the backend tips)', () => {
    expect(deriveClimateSignals(climate({ condition: 'Rain' })).rainSoon).toBe(true);
    expect(deriveClimateSignals(climate({ condition: 'Thunderstorm' })).rainSoon).toBe(true);
    expect(deriveClimateSignals(climate({ condition: 'Clear' })).rainSoon).toBe(false);
  });

  it('flags frost when the forecast low is under 5°C, falling back to current temp', () => {
    expect(
      deriveClimateSignals(climate({ forecast: [{ date: 'd', minC: 2, maxC: 10, humidity: 50 }] }))
        .frostSoon
    ).toBe(true);
    expect(deriveClimateSignals(climate({ forecast: [], tempC: 3 })).frostSoon).toBe(true);
    expect(deriveClimateSignals(climate()).frostSoon).toBe(false);
  });
});

describe('isDueWithinHours', () => {
  it('includes overdue and near-future tasks, excludes far-future and bad dates', () => {
    expect(isDueWithinHours('2026-06-09T00:00:00.000Z', 48, NOW)).toBe(true); // overdue
    expect(isDueWithinHours('2026-06-11T12:00:00.000Z', 48, NOW)).toBe(true); // +24h
    expect(isDueWithinHours('2026-06-15T00:00:00.000Z', 48, NOW)).toBe(false); // +4.5d
    expect(isDueWithinHours('not-a-date', 48, NOW)).toBe(false);
  });
});

describe('climateSkipSuggestion', () => {
  const dueSoon = { type: 'water', nextDue: '2026-06-11T00:00:00.000Z' };

  it('suggests rain for water tasks due within 48h when rain is expected', () => {
    expect(climateSkipSuggestion(dueSoon, [], { rainSoon: true, frostSoon: false }, NOW)).toBe(
      'rain'
    );
  });

  it('never suggests for non-water tasks or tasks due later than 48h', () => {
    expect(
      climateSkipSuggestion(
        { type: 'fertilize', nextDue: dueSoon.nextDue },
        [],
        { rainSoon: true, frostSoon: false },
        NOW
      )
    ).toBeNull();
    expect(
      climateSkipSuggestion(
        { type: 'water', nextDue: '2026-07-01T00:00:00.000Z' },
        [],
        { rainSoon: true, frostSoon: false },
        NOW
      )
    ).toBeNull();
  });

  it('suggests frost only for outdoor-tagged plants', () => {
    const frostOnly = { rainSoon: false, frostSoon: true };
    expect(climateSkipSuggestion(dueSoon, ['outdoor'], frostOnly, NOW)).toBe('frost');
    expect(climateSkipSuggestion(dueSoon, ['tropical'], frostOnly, NOW)).toBeNull();
    expect(climateSkipSuggestion(dueSoon, undefined, frostOnly, NOW)).toBeNull();
  });

  it('prefers rain over frost when both apply', () => {
    expect(
      climateSkipSuggestion(dueSoon, ['outdoor'], { rainSoon: true, frostSoon: true }, NOW)
    ).toBe('rain');
  });

  it('returns null when no signal is active', () => {
    expect(climateSkipSuggestion(dueSoon, ['outdoor'], NO_SIGNALS, NOW)).toBeNull();
  });
});
