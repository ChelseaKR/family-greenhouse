import { describe, it, expect } from 'vitest';
import {
  PET_TOXICITY,
  normalizeName,
  lookupToxicity,
  type PetToxicityEntry,
} from '../../../src/models/petToxicity.js';

const VERDICTS = ['toxic', 'non-toxic'] as const;

describe('pet toxicity catalog integrity', () => {
  it('ships at least one entry', () => {
    expect(PET_TOXICITY.length).toBeGreaterThan(0);
  });

  it('every entry has all required fields present and non-empty', () => {
    for (const e of PET_TOXICITY) {
      expect(typeof e.slug, `${e.slug}: slug`).toBe('string');
      expect(e.slug.length, `${e.slug}: slug non-empty`).toBeGreaterThan(0);
      expect(e.commonName?.trim().length, `${e.slug}: commonName`).toBeGreaterThan(0);
      expect(e.scientificName?.trim().length, `${e.slug}: scientificName`).toBeGreaterThan(0);
      expect(Array.isArray(e.aliases), `${e.slug}: aliases is array`).toBe(true);
      expect(e.note?.trim().length, `${e.slug}: note`).toBeGreaterThan(0);
    }
  });

  it('every slug is unique', () => {
    const slugs = PET_TOXICITY.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every slug is kebab-case and url-safe', () => {
    for (const e of PET_TOXICITY) {
      expect(e.slug, `${e.slug}: kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('no two entries share a scientific name (case-insensitive)', () => {
    const sci = PET_TOXICITY.map((e) => e.scientificName.toLowerCase());
    const dups = sci.filter((s, i) => sci.indexOf(s) !== i);
    expect(dups, `duplicate scientific names: ${[...new Set(dups)].join(', ')}`).toEqual([]);
  });

  it('cats and dogs verdicts are valid enum members', () => {
    for (const e of PET_TOXICITY) {
      expect(VERDICTS, `${e.slug}: cats`).toContain(e.cats);
      expect(VERDICTS, `${e.slug}: dogs`).toContain(e.dogs);
    }
  });

  it('aliases are non-empty strings with no exact (raw) duplicates', () => {
    // Catch true copy-paste dupes. We dedupe on the raw (trimmed, lowercased)
    // string — NOT the normalized form — because the catalog intentionally
    // lists punctuation/spelling variants (e.g. "devil's ivy" + "devils ivy")
    // that the matcher's normalizeName folds together at query time.
    for (const e of PET_TOXICITY) {
      for (const alias of e.aliases) {
        expect(typeof alias, `${e.slug}: alias type`).toBe('string');
        expect(alias.trim().length, `${e.slug}: alias non-empty`).toBeGreaterThan(0);
      }
      const raw = e.aliases.map((a) => a.trim().toLowerCase());
      expect(new Set(raw).size, `${e.slug}: exact duplicate aliases`).toBe(raw.length);
    }
  });

  it('no normalized name collides across two different entries', () => {
    // The matcher indexes commonName + scientificName + aliases. If the same
    // normalized token maps to two different slugs, an "exact" lookup becomes
    // ambiguous — flag it so we notice before shipping a confusing answer.
    const seen = new Map<string, string>();
    for (const e of PET_TOXICITY) {
      const names = [e.commonName, e.scientificName, ...e.aliases].map(normalizeName);
      for (const n of names) {
        const prior = seen.get(n);
        if (prior && prior !== e.slug) {
          throw new Error(`normalized name "${n}" maps to both "${prior}" and "${e.slug}"`);
        }
        seen.set(n, e.slug);
      }
    }
  });

  it('the note (the harm-sensitive field) is substantive, not a stub', () => {
    // The note is what a worried pet owner reads. Guard against an accidental
    // one-word placeholder while leaving room for honest brevity.
    for (const e of PET_TOXICITY) {
      expect(e.note.length, `${e.slug}: note too short`).toBeGreaterThanOrEqual(20);
    }
  });

  it('a fully-toxic entry never calls itself non-toxic in its own note', () => {
    // Liability guard: an entry marked toxic must not contain reassuring
    // "non-toxic to cats and dogs" prose. This catches a verdict/prose
    // contradiction without re-litigating the (ASPCA-grounded) verdict itself.
    for (const e of PET_TOXICITY) {
      if (e.cats === 'toxic' && e.dogs === 'toxic') {
        expect(
          e.note.toLowerCase().includes('non-toxic to cats and dogs'),
          `${e.slug}: toxic entry claims non-toxic in its note`
        ).toBe(false);
      }
    }
  });
});

describe('normalizeName', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeName('Snake-Plant!')).toBe('snake plant');
    expect(normalizeName('  Devil’s   Ivy  ')).toBe('devils ivy');
    expect(normalizeName("Mother-in-law's tongue")).toBe('mother in laws tongue');
  });
});

describe('lookupToxicity', () => {
  it('resolves an exact common name to its entry', () => {
    const [hit] = lookupToxicity('pothos');
    expect(hit?.slug).toBe('pothos');
    expect(hit?.cats).toBe('toxic');
  });

  it('resolves via alias and scientific name', () => {
    expect(lookupToxicity('devil’s ivy')[0]?.slug).toBe('pothos');
    expect(lookupToxicity('Epipremnum aureum')[0]?.slug).toBe('pothos');
  });

  it('flags the dangerous true lily as toxic to cats', () => {
    // "lilium" is unique to the true-lily entry (the genus-level scientific
    // name); a bare "lily" substring-matches peace lily / daylily too.
    const [hit] = lookupToxicity('lilium');
    expect(hit?.slug).toBe('lily');
    expect(hit?.cats).toBe('toxic');
  });

  it('returns the dangerous true lily somewhere in the results for a bare "lily" query', () => {
    const slugs = lookupToxicity('lily', 10).map((m) => m.slug);
    expect(slugs).toContain('lily');
  });

  it('returns nothing for sub-2-char or unknown queries', () => {
    expect(lookupToxicity('a')).toEqual([]);
    expect(lookupToxicity('zzzznotaplant')).toEqual([]);
  });

  it('honors the result limit', () => {
    expect(lookupToxicity('plant', 2).length).toBeLessThanOrEqual(2);
  });

  it('never returns a match shape with missing verdicts', () => {
    for (const m of lookupToxicity('lily', 5)) {
      expect(VERDICTS).toContain(m.cats);
      expect(VERDICTS).toContain(m.dogs);
      expect(m.note.length).toBeGreaterThan(0);
    }
  });
});

// Type-only guard: keeps the exported entry type exercised by the suite.
const _typeCheck: PetToxicityEntry | undefined = PET_TOXICITY[0];
void _typeCheck;
