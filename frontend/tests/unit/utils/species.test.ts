import { describe, expect, it } from 'vitest';
import { searchSpecies, speciesCatalog } from '@/utils/species';

describe('searchSpecies', () => {
  it('returns [] for empty queries', () => {
    expect(searchSpecies('')).toEqual([]);
    expect(searchSpecies('   ')).toEqual([]);
  });

  it('matches by common name prefix', () => {
    const results = searchSpecies('mons');
    expect(results[0].scientific).toContain('Monstera');
  });

  it('matches by scientific name', () => {
    const results = searchSpecies('Epipremnum aureum');
    expect(results[0].scientific).toBe('Epipremnum aureum');
  });

  it('is case-insensitive', () => {
    const lower = searchSpecies('snake');
    const upper = searchSpecies('SNAKE');
    expect(upper[0].scientific).toBe(lower[0].scientific);
  });

  it('honors the limit', () => {
    expect(searchSpecies('a', 3).length).toBeLessThanOrEqual(3);
  });

  it('catalog entries each have both common + scientific names', () => {
    for (const entry of speciesCatalog) {
      expect(entry.common.length).toBeGreaterThan(0);
      expect(entry.scientific.length).toBeGreaterThan(0);
    }
  });
});
