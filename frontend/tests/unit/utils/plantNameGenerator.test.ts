import { describe, expect, it } from 'vitest';
import { generatePlantName } from '@/utils/plantNameGenerator';

describe('generatePlantName', () => {
  it('returns a non-empty string with first + last at minimum', () => {
    const name = generatePlantName(() => 0.5);
    expect(name.length).toBeGreaterThan(2);
    // No-title path produces exactly two whitespace-separated tokens.
    expect(name.split(' ').length).toBeGreaterThanOrEqual(2);
  });

  it('uses a title when rng() < 0.3', () => {
    // Force the title branch and make every pick deterministic.
    const rng = () => 0;
    const name = generatePlantName(rng);
    expect(name.split(' ').length).toBe(3);
  });

  it('skips the title when rng() >= 0.3', () => {
    let calls = 0;
    const rng = () => {
      calls += 1;
      // First call decides title (>= 0.3 => skip); subsequent calls index picks.
      return calls === 1 ? 0.5 : 0;
    };
    const name = generatePlantName(rng);
    expect(name.split(' ').length).toBe(2);
  });

  it('produces different names across calls (with real randomness)', () => {
    const names = new Set(Array.from({ length: 30 }, () => generatePlantName()));
    // 30 calls into a name space of ~600 combos; collisions extremely unlikely.
    expect(names.size).toBeGreaterThan(20);
  });
});
