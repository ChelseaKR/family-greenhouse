import { describe, expect, it } from 'vitest';
import { deriveClimateTips } from '../../../src/services/climate.js';
import type { WeatherSnapshot } from '../../../src/services/weather.js';

const base: WeatherSnapshot = {
  observedAt: new Date().toISOString(),
  tempC: 20,
  humidity: 50,
  condition: 'Clear',
  description: 'clear sky',
  forecast: [
    { date: '2026-04-25', minC: 14, maxC: 22, humidity: 45 },
    { date: '2026-04-26', minC: 13, maxC: 21, humidity: 50 },
    { date: '2026-04-27', minC: 15, maxC: 23, humidity: 48 },
  ],
};

describe('deriveClimateTips', () => {
  it('returns no tips for benign conditions', () => {
    expect(deriveClimateTips(base)).toEqual([]);
  });

  it('flags low humidity as a warning targeting tropicals', () => {
    const tips = deriveClimateTips({ ...base, humidity: 22 });
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ level: 'warning', appliesTo: ['tropical'] });
    expect(tips[0].message).toMatch(/22%/);
  });

  it('flags high humidity as info targeting succulents', () => {
    const tips = deriveClimateTips({ ...base, humidity: 78 });
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ level: 'info', appliesTo: ['succulent'] });
  });

  it('flags freeze risk when forecast low is under 5C', () => {
    const tips = deriveClimateTips({
      ...base,
      forecast: [{ date: 'd', minC: 1, maxC: 8, humidity: 60 }],
    });
    expect(tips.some((t) => /bring tender plants indoors/i.test(t.message))).toBe(true);
  });

  it('skips watering hint when rain is in the condition', () => {
    const tips = deriveClimateTips({ ...base, condition: 'Rain', description: 'light rain' });
    expect(tips.some((t) => t.appliesTo.includes('outdoor') && /rain/i.test(t.message))).toBe(true);
  });

  it('flags hot days', () => {
    const tips = deriveClimateTips({ ...base, tempC: 35 });
    expect(tips.some((t) => /hot today/i.test(t.message))).toBe(true);
  });

  it('can stack multiple tips at once (low humidity + cold night)', () => {
    const tips = deriveClimateTips({
      ...base,
      humidity: 25,
      forecast: [{ date: 'd', minC: 2, maxC: 9, humidity: 30 }],
    });
    expect(tips.length).toBeGreaterThanOrEqual(2);
  });
});
