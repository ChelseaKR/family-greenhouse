import { describe, expect, it } from 'vitest';
import {
  generatePlantName,
  generatePlantNameSuggestion,
  type PlantNameVibe,
} from '@/utils/plantNameGenerator';

describe('plant name generator', () => {
  it('keeps the original one-line helper usable', () => {
    const name = generatePlantName(() => 0.5);
    expect(name.trim().length).toBeGreaterThan(2);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it.each<PlantNameVibe>(['punny', 'distinguished', 'chaotic', 'sweet'])(
    'returns a complete %s suggestion',
    (vibe) => {
      const suggestion = generatePlantNameSuggestion(vibe, '', () => 0);

      expect(suggestion.vibe).toBe(vibe);
      expect(suggestion.name.trim()).not.toBe('');
      expect(suggestion.note.trim()).not.toBe('');
      expect(suggestion.name.length).toBeLessThanOrEqual(100);
    }
  );

  it('uses a common species name for a tailored pun', () => {
    const suggestion = generatePlantNameSuggestion('punny', 'Boston fern', () => 0);
    expect(suggestion.name).toBe('Fernie');
    expect(suggestion.speciesMatch).toEqual({ id: 'fern', label: 'ferns' });
  });

  it.each<PlantNameVibe>(['punny', 'distinguished', 'chaotic', 'sweet'])(
    'tailors the %s personality to the species',
    (vibe) => {
      const suggestion = generatePlantNameSuggestion(vibe, 'Monstera deliciosa', () => 0);

      expect(suggestion.speciesMatch).toEqual({ id: 'monstera', label: 'monsteras' });
      expect(suggestion.name).toMatch(
        /Monsterra Deliciosa|Professor Fenestration|The Hole Situation|Little Monster/
      );
    }
  );

  it('recognizes a scientific name even when the common name is absent', () => {
    const suggestion = generatePlantNameSuggestion('distinguished', 'Epipremnum aureum', () => 0);

    expect(suggestion.name).toBe('Sir Trails-a-Lot');
    expect(suggestion.speciesMatch?.id).toBe('pothos');
  });

  it('preserves tailored palm support', () => {
    const suggestion = generatePlantNameSuggestion('chaotic', 'Parlor palm', () => 0);

    expect(suggestion.name).toBe('Vacation Mode');
    expect(suggestion.speciesMatch?.id).toBe('palm');
  });

  it('falls back gracefully for an unknown species', () => {
    const suggestion = generatePlantNameSuggestion('sweet', 'Mysteriophyta fabulous', () => 0);

    expect(suggestion.name).toBe('Bean Baby');
    expect(suggestion.speciesMatch).toBeUndefined();
  });

  it('is deterministic when supplied with a seeded rng', () => {
    const first = generatePlantNameSuggestion('distinguished', '', () => 0.25);
    const second = generatePlantNameSuggestion('distinguished', '', () => 0.25);
    expect(first).toEqual(second);
  });

  it('produces a broad mix of names for a deterministic pseudo-random sequence', () => {
    // A seeded sequence verifies variety without making the suite probabilistic.
    let state = 0x12345678;
    const rng = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const names = new Set(
      Array.from({ length: 40 }, () => generatePlantNameSuggestion('surprise', '', rng).name)
    );
    expect(names.size).toBeGreaterThan(20);
  });
});
