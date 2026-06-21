import { describe, it, expect } from 'vitest';
import { speciesCatalog, searchSpecies, type SpeciesEntry } from './species';

const norm = (s: string) => s.trim().toLowerCase();

describe('species catalog integrity', () => {
  it('ships a substantial catalog', () => {
    expect(speciesCatalog.length).toBeGreaterThan(100);
  });

  it('every entry has non-empty, trimmed common and scientific names', () => {
    for (const e of speciesCatalog) {
      expect(typeof e.common, `${e.common}: common is a string`).toBe('string');
      expect(e.common.trim().length, `"${e.common}": common non-empty`).toBeGreaterThan(0);
      expect(e.common, `"${e.common}": common has no stray whitespace`).toBe(e.common.trim());
      expect(typeof e.scientific, `${e.common}: scientific is a string`).toBe('string');
      expect(e.scientific.trim().length, `"${e.common}": scientific non-empty`).toBeGreaterThan(0);
      expect(e.scientific, `"${e.scientific}": scientific has no stray whitespace`).toBe(
        e.scientific.trim()
      );
    }
  });

  it('no two entries share a common name (case-insensitive)', () => {
    // The common name is the catalog's identity: searchSpecies ranks by it and
    // SpeciesCombobox dedups + keys on it. A repeated common name is a real bug
    // — it surfaces the same plant twice and risks a duplicate React key.
    //
    // Scientific names, by contrast, MAY repeat by design: one species is often
    // known by several common names ("Pothos" / "Devil's ivy" are both
    // Epipremnum aureum), and each is a useful autocomplete entry point. So we
    // deliberately do NOT assert scientific-name uniqueness here.
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const e of speciesCatalog) {
      const key = norm(e.common);
      const prior = seen.get(key);
      if (prior) dups.push(`"${e.common}" (also as "${prior}")`);
      else seen.set(key, e.common);
    }
    expect(dups, `duplicate common names: ${dups.join('; ')}`).toEqual([]);
  });

  it('no exact (common, scientific) row is repeated', () => {
    const pairs = speciesCatalog.map((e) => `${norm(e.common)}||${norm(e.scientific)}`);
    const dups = [...new Set(pairs.filter((p, i) => pairs.indexOf(p) !== i))];
    expect(dups, `duplicated rows: ${dups.join(', ')}`).toEqual([]);
  });

  it('scientific names are botanical: capitalized genus, no double-quoted cultivars', () => {
    for (const e of speciesCatalog) {
      expect(e.scientific, `"${e.scientific}": capitalized genus`).toMatch(/^[A-Z]/);
      // Allowed characters: letters, spaces, the hybrid mark ×, hyphens, and
      // single quotes for cultivar epithets (the ICNCP convention, e.g.
      // Philodendron 'Birkin'). Double quotes are a style slip we standardized.
      expect(e.scientific, `"${e.scientific}": botanical charset`).toMatch(/^[A-Za-z×' -]+$/);
      expect(e.scientific.includes('"'), `"${e.scientific}": cultivar uses single quotes`).toBe(
        false
      );
    }
  });

  it('common names start with a letter (no leading punctuation or casing noise)', () => {
    for (const e of speciesCatalog) {
      expect(e.common, `"${e.common}": sane leading character`).toMatch(/^[A-Za-z]/);
    }
  });
});

describe('searchSpecies', () => {
  it('returns nothing for an empty or whitespace query', () => {
    expect(searchSpecies('')).toEqual([]);
    expect(searchSpecies('   ')).toEqual([]);
  });

  it('ranks an exact common-name match first', () => {
    const [top] = searchSpecies('Monstera');
    expect(top?.common).toBe('Monstera');
  });

  it('matches on the scientific name too', () => {
    const hits = searchSpecies('Epipremnum aureum');
    expect(hits.some((e: SpeciesEntry) => norm(e.scientific) === 'epipremnum aureum')).toBe(true);
  });

  it('honors the result limit', () => {
    expect(searchSpecies('a', 3).length).toBeLessThanOrEqual(3);
  });
});
