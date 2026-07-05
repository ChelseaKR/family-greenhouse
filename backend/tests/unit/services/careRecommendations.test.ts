import { describe, expect, it } from 'vitest';
import { deriveCareSuggestion } from '../../../src/services/careRecommendations.js';
import type { PerenualSpeciesDetail } from '../../../src/services/perenual.js';

const base: PerenualSpeciesDetail = {
  id: 1,
  commonName: 'Test',
  scientificName: 'Testus testus',
  thumbnailUrl: null,
  family: null,
  cycle: null,
  watering: 'average',
  sunlight: ['part shade'],
  hardinessZone: null,
  indoor: true,
  edible: false,
  poisonousToPets: false,
  defaultImageUrl: null,
};

describe('deriveCareSuggestion', () => {
  it('maps each Perenual watering band to a sensible day cadence', () => {
    expect(deriveCareSuggestion({ ...base, watering: 'frequent' }).wateringDays).toBe(3);
    expect(deriveCareSuggestion({ ...base, watering: 'average' }).wateringDays).toBe(7);
    expect(deriveCareSuggestion({ ...base, watering: 'minimum' }).wateringDays).toBe(14);
    expect(deriveCareSuggestion({ ...base, watering: 'none' }).wateringDays).toBeNull();
    expect(deriveCareSuggestion({ ...base, watering: null }).wateringDays).toBeNull();
  });

  it('distinguishes an explicit "no watering needed" from missing watering data', () => {
    // Perenual explicitly says this species needs no regular watering.
    const explicitNone = deriveCareSuggestion({ ...base, watering: 'none' });
    expect(explicitNone.summary).toMatch(/no regular watering needed/i);

    // Perenual has no watering data at all (e.g. a less-mainstream species
    // like Cinnamomum cassia) — must not claim "no watering needed"; that's
    // a guess, not a fact from the data source.
    const unknown = deriveCareSuggestion({ ...base, watering: null });
    expect(unknown.summary).not.toMatch(/no regular watering needed/i);
    expect(unknown.summary).toMatch(/watering data isn't available/i);
  });

  it('summarizes light requirements when present', () => {
    const out = deriveCareSuggestion({ ...base, sunlight: ['full sun', 'part shade'] });
    expect(out.summary).toContain('full sun');
    expect(out.summary).toContain('part shade');
  });

  it('flags pet toxicity in the summary', () => {
    const out = deriveCareSuggestion({ ...base, poisonousToPets: true });
    expect(out.summary).toMatch(/toxic to pets/i);
  });

  it('uses different phrasing for short vs. long cadences', () => {
    const fast = deriveCareSuggestion({ ...base, watering: 'frequent' });
    const slow = deriveCareSuggestion({ ...base, watering: 'minimum' });
    expect(fast.summary).toContain('roughly every');
    expect(slow.summary).toContain('about every');
  });
});
