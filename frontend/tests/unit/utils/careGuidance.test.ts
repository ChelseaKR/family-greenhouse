import { describe, expect, it } from 'vitest';
import { findCareGuide, CARE_GUIDES } from '@/utils/careGuidance';

describe('findCareGuide', () => {
  it('matches by exact scientific name', () => {
    expect(findCareGuide('Monstera deliciosa')?.common).toBe('Monstera');
  });

  it('matches case-insensitively', () => {
    expect(findCareGuide('monstera deliciosa')?.common).toBe('Monstera');
  });

  it('matches by keyword in free-text species', () => {
    expect(findCareGuide('Pothos cuttings I propagated')?.common).toBe('Pothos');
  });

  it('returns undefined for null/empty', () => {
    expect(findCareGuide(null)).toBeUndefined();
    expect(findCareGuide('')).toBeUndefined();
    expect(findCareGuide('   ')).toBeUndefined();
  });

  it('returns undefined for unknown species rather than guessing', () => {
    expect(findCareGuide('Zamia furfuracea')).toBeUndefined();
  });

  it('every catalog entry has all required fields', () => {
    for (const g of CARE_GUIDES) {
      expect(g.scientific.length).toBeGreaterThan(0);
      expect(g.common.length).toBeGreaterThan(0);
      expect(g.keywords.length).toBeGreaterThan(0);
      expect(g.light.length).toBeGreaterThan(20);
      expect(g.water.length).toBeGreaterThan(20);
      expect(g.humidity.length).toBeGreaterThan(0);
      expect(g.notes.length).toBeGreaterThan(20);
    }
  });
});
