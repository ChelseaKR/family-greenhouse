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

  it('flags asparagus fern as toxic, not the unrelated non-toxic Boston fern', () => {
    // Regression: "asparagus fern" used to word-overlap-match Boston fern's
    // bare "fern" alias and return a confident (wrong) non-toxic verdict for
    // a genuinely toxic plant.
    const slugs = lookupToxicity('asparagus fern', 5).map((m) => m.slug);
    expect(slugs).toContain('asparagus-fern');
    expect(slugs).not.toContain('boston-fern');
    const [hit] = lookupToxicity('asparagus fern');
    expect(hit?.cats).toBe('toxic');
    expect(hit?.dogs).toBe('toxic');
  });

  it('emerald fern and foxtail fern (asparagus fern aliases) also resolve to the toxic entry', () => {
    expect(lookupToxicity('emerald fern')[0]?.slug).toBe('asparagus-fern');
    expect(lookupToxicity('foxtail fern')[0]?.slug).toBe('asparagus-fern');
  });

  it('a bare single-word query still matches via the loose word-overlap tier', () => {
    // The tightened word tier requires ALL query words to match — for a
    // single-word query that's unchanged behavior (every === some here).
    const slugs = lookupToxicity('fern', 5).map((m) => m.slug);
    expect(slugs).toContain('boston-fern');
  });

  it('the word-overlap tier requires every query word to appear, not just one', () => {
    // A query combining a real word from one entry with a nonsense word
    // should NOT match on the strength of the one real word alone.
    expect(lookupToxicity('zzznotaword fern').map((m) => m.slug)).not.toContain('boston-fern');
  });
});

describe('care-guide coverage (#384)', () => {
  // Every /care/<plant> guide must resolve in the checker, or /pet-safe says
  // "we don't have that one yet" for a plant the site publishes a full guide
  // for. Slugs are the care-guide slugs; the toxicity table is allowed to
  // reach them via a different slug (heartleaf-philodendron → philodendron)
  // as long as the lookup lands on a row.
  const GUIDE_QUERIES: Array<[query: string, expectedSlug: string]> = [
    // Pre-existing guides.
    ['pothos', 'pothos'],
    ['snake plant', 'snake-plant'],
    ['monstera', 'monstera'],
    ['spider plant', 'spider-plant'],
    ['peace lily', 'peace-lily'],
    ['heartleaf philodendron', 'philodendron'],
    ['zz plant', 'zz-plant'],
    ['aloe vera', 'aloe-vera'],
    ['dieffenbachia', 'dieffenbachia'],
    ['calathea', 'calathea'],
    // Guides added by #384.
    ['fiddle leaf fig', 'fiddle-leaf-fig'],
    ['rubber plant', 'rubber-plant'],
    ['bird of paradise', 'bird-of-paradise'],
    ['anthurium', 'anthurium'],
    ['chinese evergreen', 'chinese-evergreen'],
    ['jade plant', 'jade-plant'],
    ['english ivy', 'english-ivy'],
    ['boston fern', 'boston-fern'],
    ['money tree', 'money-tree'],
    ['christmas cactus', 'christmas-cactus'],
    ['parlor palm', 'parlor-palm'],
    ['orchid', 'orchid'],
    ['hoya', 'hoya'],
    ['nerve plant', 'nerve-plant'],
  ];

  it.each(GUIDE_QUERIES)('“%s” resolves to the %s row', (query, expectedSlug) => {
    const [hit] = lookupToxicity(query);
    expect(hit?.slug, `"${query}" did not resolve to a toxicity row`).toBe(expectedSlug);
  });

  it('every care-guide plant returns a usable verdict, never an empty result', () => {
    for (const [query] of GUIDE_QUERIES) {
      const results = lookupToxicity(query);
      expect(
        results.length,
        `"${query}": /pet-safe would say "not in our checker"`
      ).toBeGreaterThan(0);
      expect(VERDICTS, `"${query}": cats`).toContain(results[0].cats);
      expect(VERDICTS, `"${query}": dogs`).toContain(results[0].dogs);
    }
  });
});

describe('verdicts for the #384 additions match their ASPCA entry', () => {
  // Each expectation below was read off that plant's own ASPCA listing.
  // Changing one of these means you are contradicting the ASPCA — go re-read
  // the source page first.
  const EXPECTED: Array<[slug: string, cats: string, dogs: string, aspcaEntry: string]> = [
    ['bird-of-paradise', 'toxic', 'toxic', 'Bird of Paradise Flower (Strelitzia reginae)'],
    ['anthurium', 'toxic', 'toxic', 'Flamingo Flower (Anthurium scherzeranum)'],
    ['chinese-evergreen', 'toxic', 'toxic', 'Chinese Evergreen (Aglaonema modestum)'],
    ['english-ivy', 'toxic', 'toxic', 'English Ivy (Hedera helix)'],
    ['money-tree', 'non-toxic', 'non-toxic', 'Money Tree (Pachira aquatica)'],
    ['christmas-cactus', 'non-toxic', 'non-toxic', 'Christmas Cactus (Schlumbergera bridgesii)'],
    ['parlor-palm', 'non-toxic', 'non-toxic', 'Parlor Palm (Chamaedorea elegans)'],
    ['hoya', 'non-toxic', 'non-toxic', "Wax Plant (Hoya carnosa 'krinkle kurl')"],
    ['nerve-plant', 'non-toxic', 'non-toxic', 'Nerve Plant (Fittonia verschaffeltii)'],
  ];

  it.each(EXPECTED)('%s is %s to cats / %s to dogs per ASPCA %s', (slug, cats, dogs) => {
    const entry = PET_TOXICITY.find((e) => e.slug === slug);
    expect(entry, `${slug} missing from the catalog`).toBeDefined();
    expect(entry?.cats).toBe(cats);
    expect(entry?.dogs).toBe(dogs);
  });
});

describe('alias collision traps', () => {
  // These are the cases where a fuzzy match would tell someone a toxic plant
  // is safe for their cat. Each one is a real, documented ambiguity in common
  // plant naming — not a hypothetical.

  it('“money plant” resolves to toxic pothos, NOT the non-toxic money tree', () => {
    // ASPCA lists "Money Plant" as an additional common name for the
    // non-toxic Pachira aquatica, but in ordinary use it far more often means
    // pothos or jade — both toxic. The checker must take the conservative
    // reading rather than hand a pothos owner a green "pet-safe" card.
    const results = lookupToxicity('money plant', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('pothos');
    expect(results[0].cats).toBe('toxic');
    expect(results.map((m) => m.slug)).not.toContain('money-tree');
  });

  it('no non-toxic row is reachable from a “money plant” query at all', () => {
    for (const m of lookupToxicity('money plant', 20)) {
      expect(
        m.cats === 'toxic' || m.dogs === 'toxic',
        `"money plant" surfaced non-toxic ${m.slug}`
      ).toBe(true);
    }
  });

  it('“money tree” resolves to the non-toxic Pachira and not to pothos or jade', () => {
    const [hit] = lookupToxicity('money tree');
    expect(hit?.slug).toBe('money-tree');
    expect(hit?.cats).toBe('non-toxic');
    const slugs = lookupToxicity('money tree', 10).map((m) => m.slug);
    expect(slugs).not.toContain('pothos');
    expect(slugs).not.toContain('jade-plant');
  });

  it('the money tree row never claims the “money plant” name', () => {
    // Structural guard: even if someone "helpfully" adds the alias later,
    // this fails before it can ship.
    const moneyTree = PET_TOXICITY.find((e) => e.slug === 'money-tree');
    const names = [moneyTree!.commonName, moneyTree!.scientificName, ...moneyTree!.aliases].map(
      normalizeName
    );
    expect(names, 'money-tree must not carry the ambiguous "money plant" alias').not.toContain(
      'money plant'
    );
  });

  it('a bare “palm” query leads with the severely toxic sago palm', () => {
    // Sago palm causes liver failure and is often fatal. Parlor palm is
    // non-toxic. If the non-toxic one leads, a worried owner reads
    // "pet-safe" for the plant that can kill their dog.
    const results = lookupToxicity('palm', 10);
    const slugs = results.map((m) => m.slug);
    expect(slugs).toContain('sago-palm');
    expect(results[0].slug).toBe('sago-palm');
    expect(results[0].cats).toBe('toxic');
  });

  it('“sago palm” never resolves to the non-toxic parlor palm', () => {
    const slugs = lookupToxicity('sago palm', 10).map((m) => m.slug);
    expect(slugs).toContain('sago-palm');
    expect(slugs).not.toContain('parlor-palm');
    expect(lookupToxicity('sago palm')[0].cats).toBe('toxic');
  });

  it('“parlor palm” resolves to the non-toxic row without dragging in sago palm', () => {
    const [hit] = lookupToxicity('parlor palm');
    expect(hit?.slug).toBe('parlor-palm');
    expect(hit?.cats).toBe('non-toxic');
    expect(lookupToxicity('parlor palm', 10).map((m) => m.slug)).not.toContain('sago-palm');
  });

  it('the parlor palm row never claims the bare “palm” name', () => {
    const parlor = PET_TOXICITY.find((e) => e.slug === 'parlor-palm');
    const names = [parlor!.commonName, parlor!.scientificName, ...parlor!.aliases].map(
      normalizeName
    );
    expect(names, 'parlor-palm must not carry a bare "palm" alias').not.toContain('palm');
  });

  it('a bare “fern” query leads with the toxic asparagus fern, not Boston fern', () => {
    // Asparagus fern is not a true fern and IS toxic; Boston fern is safe.
    // Both legitimately match "fern", so the toxic one must lead.
    const results = lookupToxicity('fern', 10);
    const slugs = results.map((m) => m.slug);
    expect(slugs).toContain('asparagus-fern');
    expect(slugs).toContain('boston-fern');
    expect(results[0].slug).toBe('asparagus-fern');
    expect(results[0].cats).toBe('toxic');
  });

  it('a bare “christmas” query leads with toxic poinsettia, not the non-toxic cactus', () => {
    const results = lookupToxicity('christmas', 10);
    const slugs = results.map((m) => m.slug);
    expect(slugs).toContain('poinsettia');
    expect(slugs).toContain('christmas-cactus');
    expect(results[0].slug).toBe('poinsettia');
    expect(results[0].cats).toBe('toxic');
  });

  it('“christmas cactus” resolves to the non-toxic cactus, not to poinsettia', () => {
    const [hit] = lookupToxicity('christmas cactus');
    expect(hit?.slug).toBe('christmas-cactus');
    expect(hit?.cats).toBe('non-toxic');
    expect(lookupToxicity('christmas cactus', 10).map((m) => m.slug)).not.toContain('poinsettia');
  });

  it('the dangerous true lily still surfaces for a bare “lily” query at the default limit', () => {
    // Adding anthurium's "flamingo lily" alias must not push the true lily
    // (fatal kidney failure in cats) out of the default result window.
    const slugs = lookupToxicity('lily').map((m) => m.slug);
    expect(slugs, 'true lily fell out of the default "lily" results').toContain('lily');
  });

  it('every “lily”-matching row is toxic, so the query can never read as safe', () => {
    for (const m of lookupToxicity('lily', 20)) {
      expect(m.cats === 'toxic' || m.dogs === 'toxic', `"lily" surfaced non-toxic ${m.slug}`).toBe(
        true
      );
    }
  });

  it('every “ivy”-matching row is toxic (english ivy and devil’s ivy both are)', () => {
    const results = lookupToxicity('ivy', 20);
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((m) => m.slug)).toContain('english-ivy');
    for (const m of results) {
      expect(m.cats === 'toxic' || m.dogs === 'toxic', `"ivy" surfaced non-toxic ${m.slug}`).toBe(
        true
      );
    }
  });

  it('“prayer plant” resolves to calathea, matching ASPCA’s Calathea insignis entry', () => {
    // ASPCA's "Prayer Plant" entry IS Calathea insignis (non-toxic), listing
    // Maranta and Rattlesnake Plant among its other common names — so the
    // calathea row legitimately owns all of these aliases.
    const [hit] = lookupToxicity('prayer plant');
    expect(hit?.slug).toBe('calathea');
    expect(hit?.cats).toBe('non-toxic');
    expect(lookupToxicity('maranta')[0]?.slug).toBe('calathea');
    expect(lookupToxicity('rattlesnake plant')[0]?.slug).toBe('calathea');
  });

  it('“bird of paradise” resolves toxic regardless of which species is meant', () => {
    // Two plants share the name: Strelitzia reginae (this row) and the
    // harsher Caesalpinia gilliesii. Both are toxic, so the verdict is safe
    // either way — but the row must not be reachable by Caesalpinia's own
    // common names, which would answer about the wrong plant.
    const [hit] = lookupToxicity('bird of paradise');
    expect(hit?.slug).toBe('bird-of-paradise');
    expect(hit?.cats).toBe('toxic');
    expect(hit?.dogs).toBe('toxic');
    for (const caesalpinia of ['peacock flower', 'pride of barbados', 'poinciana']) {
      expect(
        lookupToxicity(caesalpinia).map((m) => m.slug),
        `${caesalpinia} (Caesalpinia) must not resolve to the Strelitzia row`
      ).not.toContain('bird-of-paradise');
    }
  });

  it('“asparagus fern” still never returns the non-toxic Boston fern', () => {
    // Re-assert the original regression now that more fern-adjacent rows and
    // the toxic-first ordering exist.
    const slugs = lookupToxicity('asparagus fern', 10).map((m) => m.slug);
    expect(slugs).toContain('asparagus-fern');
    expect(slugs).not.toContain('boston-fern');
  });

  it('“boston fern” resolves to the non-toxic row without dragging in asparagus fern', () => {
    const [hit] = lookupToxicity('boston fern');
    expect(hit?.slug).toBe('boston-fern');
    expect(hit?.cats).toBe('non-toxic');
    expect(lookupToxicity('boston fern', 10).map((m) => m.slug)).not.toContain('asparagus-fern');
  });
});

describe('toxic-first ordering never widens the result set', () => {
  // The ordering change must be a pure permutation within tiers: same
  // entries, different order. If it ever adds a match it has loosened the
  // matcher, which is the one thing we must not do.
  const QUERIES = [
    'fern',
    'palm',
    'lily',
    'ivy',
    'christmas',
    'plant',
    'money plant',
    'money tree',
    'pothos',
    'zzzznotaplant',
  ];

  it.each(QUERIES)('“%s” returns only entries that genuinely match', (query) => {
    const q = normalizeName(query);
    const qWords = q.split(' ').filter((w) => w.length >= 3);
    for (const m of lookupToxicity(query, 50)) {
      const entry = PET_TOXICITY.find((e) => e.slug === m.slug)!;
      const names = [entry.commonName, entry.scientificName, ...entry.aliases].map(normalizeName);
      const matches =
        names.some((n) => n === q || n.startsWith(q) || n.includes(q)) ||
        (qWords.length > 0 && qWords.every((w) => names.some((n) => n.includes(w))));
      expect(matches, `"${query}" returned ${m.slug}, which does not actually match`).toBe(true);
    }
  });
});

// Type-only guard: keeps the exported entry type exercised by the suite.
const _typeCheck: PetToxicityEntry | undefined = PET_TOXICITY[0];
void _typeCheck;
