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

  it('flags low humidity as a warning targeting tropicals, labelled as outdoor', () => {
    const tips = deriveClimateTips({ ...base, humidity: 22 });
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ level: 'warning', appliesTo: ['tropical'] });
    expect(tips[0].message).toMatch(/22%/);
    expect(tips[0].message).toMatch(/outdoor humidity/i);
  });

  it('flags high humidity as info targeting succulents, labelled as outdoor', () => {
    const tips = deriveClimateTips({ ...base, humidity: 78 });
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ level: 'info', appliesTo: ['succulent'] });
    expect(tips[0].message).toMatch(/outdoor humidity/i);
  });

  // The snapshot is OpenWeatherMap's reading for the household's city — an
  // OUTDOOR measurement. There is no indoor sensor in this product. A tip
  // that attaches a snapshot number to the word "indoor" is telling the user
  // something nothing in the system measured, and it changes what they do:
  // 28% outdoors on a rainy 5°C day is a very different room from 28%
  // outdoors in August.
  it('never attributes a measured percentage to indoor conditions', () => {
    for (const humidity of [5, 22, 29, 35, 55, 71, 78, 95]) {
      for (const tempC of [-5, 20, 35]) {
        for (const condition of ['Clear', 'Rain', 'Storm']) {
          for (const tip of deriveClimateTips({ ...base, humidity, tempC, condition })) {
            // Allowed: "Indoor air is usually drier still" (a qualitative
            // inference). Not allowed: the phrase "indoor humidity", or a
            // measured percentage sitting in the same sentence as "indoor".
            expect(tip.message).not.toMatch(/indoor humidity/i);
            expect(tip.message).not.toMatch(/indoors?[^.]{0,40}\d+\s*%/i);
            expect(tip.message).not.toMatch(/\d+\s*%[^.]{0,40}indoors?\b/i);
          }
        }
      }
    }
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
