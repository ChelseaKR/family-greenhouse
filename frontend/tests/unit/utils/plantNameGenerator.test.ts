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

  it('uses the species for a tailored pun when one is available', () => {
    const suggestion = generatePlantNameSuggestion('punny', 'Boston fern', () => 0);
    expect(suggestion.name).toBe('Fernie');
  });

  it('is deterministic when supplied with a seeded rng', () => {
    const first = generatePlantNameSuggestion('distinguished', '', () => 0.25);
    const second = generatePlantNameSuggestion('distinguished', '', () => 0.25);
    expect(first).toEqual(second);
  });

  it('produces varied names across real random calls', () => {
    const names = new Set(
      Array.from({ length: 40 }, () => generatePlantNameSuggestion('surprise').name)
    );
    expect(names.size).toBeGreaterThan(20);
  });
});
