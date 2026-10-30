/**
 * The rule that decides what a `/pet-safe/<slug>` page may claim, held to two
 * standards at once:
 *
 *   1. Absence is never safety. Every way an entry can fail to support a
 *      verdict — a blank, missing, null or unexpected field, no per-plant
 *      listing, a listing that is silent or disagrees, a malformed listing —
 *      lands on "not assessed", in BOTH implementations.
 *   2. The page's implementation (`plantSafetyPages.ts`) and the build gate's
 *      (`scripts/pet-toxicity-table.mjs`) agree on every real entry and every
 *      malformed one. The gate compares the prerendered page against the
 *      second; if the two could drift, the gate would be checking a different
 *      rule from the one the page follows.
 */
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';

import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
} from '../../../../backend/src/models/petToxicity';
import {
  ANIMALS,
  PLANT_SAFETY_PAGES,
  claimFor,
  findPlantSafetyPage,
  plantSafetyDetails,
  plantSafetyDetailsFrom,
  plantSafetyFaq,
  toPlantSafetyPage,
  type Animal,
  type LooseEntry,
  type PlantSafetyDetails,
} from '@/features/petsafe/plantSafetyPages';
import {
  claimFor as gateClaimFor,
  loadPetToxicityTable,
  plantDetails,
  plantFaq,
  plantPage,
  // @ts-expect-error - vanilla ESM build script, deliberately untyped
} from '../../../scripts/pet-toxicity-table.mjs';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { readCatalog } from '../../../scripts/check-plant-safety-pages.mjs';

const LISTING = {
  title: 'Fixture Listing',
  scientificName: 'Fixtura exempli',
  path: '/toxic-and-non-toxic-plants/fixture-listing',
  listed: { cats: 'non-toxic', dogs: 'non-toxic' },
};

const FIXTURE: LooseEntry = {
  slug: 'fixture-plant',
  commonName: 'Fixture plant',
  scientificName: 'Fixtura exempli',
  aliases: [],
  cats: 'non-toxic',
  dogs: 'non-toxic',
  note: 'A fixture note, long enough to be a note.',
  aspcaListing: LISTING,
};

const MALFORMED: Array<[string, LooseEntry, Animal]> = [
  ['a blank dogs field', { ...FIXTURE, dogs: '' }, 'dogs'],
  ['a missing cats field', { ...FIXTURE, cats: undefined }, 'cats'],
  ['a null dogs field', { ...FIXTURE, dogs: null }, 'dogs'],
  ['an unexpected verdict word', { ...FIXTURE, cats: 'safe' }, 'cats'],
  ['a verdict in the wrong case', { ...FIXTURE, cats: 'Non-toxic' }, 'cats'],
  ['no per-plant listing', { ...FIXTURE, aspcaListing: undefined }, 'cats'],
  [
    'a listing silent for the animal',
    { ...FIXTURE, aspcaListing: { ...LISTING, listed: { cats: 'non-toxic' } } },
    'dogs',
  ],
  [
    'a listing that disagrees with the table',
    { ...FIXTURE, aspcaListing: { ...LISTING, listed: { cats: 'toxic', dogs: 'non-toxic' } } },
    'cats',
  ],
  [
    'a listing path that is not an ASPCA plant path',
    { ...FIXTURE, aspcaListing: { ...LISTING, path: 'https://example.com/plants/fixture' } },
    'cats',
  ],
  [
    'a listing with a blank title',
    { ...FIXTURE, aspcaListing: { ...LISTING, title: '   ' } },
    'dogs',
  ],
  ['a listing that is not an object', { ...FIXTURE, aspcaListing: 'ASPCA' }, 'dogs'],
];

describe('absence is never rendered as safety', () => {
  it.each(MALFORMED)('%s is not assessed', (_label, entry, animal) => {
    expect(claimFor(entry, animal).state).toBe('not-assessed');
    expect(gateClaimFor(entry, animal, ASPCA_ANIMAL_POISON_CONTROL_URL).state).toBe('not-assessed');
  });

  it('never yields non-toxic unless the field is exactly non-toxic and its listing says so', () => {
    for (const [label, entry] of MALFORMED) {
      for (const animal of ANIMALS) {
        const claim = claimFor(entry, animal);
        if (claim.state !== 'non-toxic') continue;
        const listing = entry.aspcaListing as typeof LISTING;
        expect(entry[animal], `${label}: ${animal}`).toBe('non-toxic');
        expect(listing.listed[animal], `${label}: ${animal} listing`).toBe('non-toxic');
      }
    }
  });

  it('a well-formed fixture is published with both verdicts and its note', () => {
    const page = toPlantSafetyPage(FIXTURE);
    expect(page?.claims.cats.state).toBe('non-toxic');
    expect(page?.claims.dogs.state).toBe('non-toxic');
    expect(page?.note).toBe(FIXTURE.note);
  });

  it('one uncited animal keeps the page, marks that animal not assessed, and drops the note', () => {
    const page = toPlantSafetyPage({ ...FIXTURE, dogs: '' });
    expect(page?.claims.cats.state).toBe('non-toxic');
    expect(page?.claims.dogs.state).toBe('not-assessed');
    expect(page?.note).toBeNull();
  });

  it('an entry with no cited verdict for either animal gets no page', () => {
    expect(toPlantSafetyPage({ ...FIXTURE, aspcaListing: undefined })).toBeNull();
    expect(plantPage({ ...FIXTURE, aspcaListing: undefined }, 'x').published).toBe(false);
  });
});

describe('the page rule and the gate rule agree', () => {
  const cases: Array<[string, LooseEntry]> = [
    ...PET_TOXICITY.map((entry): [string, LooseEntry] => [entry.slug, entry]),
    ...MALFORMED.map(([label, entry]): [string, LooseEntry] => [label, entry]),
  ];

  it.each(cases)('%s', (_label, entry) => {
    const mine = toPlantSafetyPage(entry);
    const gate = plantPage(entry, ASPCA_ANIMAL_POISON_CONTROL_URL);

    expect(mine !== null).toBe(gate.published);
    if (mine === null) return;
    for (const animal of ANIMALS) {
      const a = mine.claims[animal];
      const b = gate.claims[animal];
      expect(a.state, animal).toBe(b.state);
      if (a.state !== 'not-assessed') expect(a.source).toEqual(b.source);
    }
    expect(mine.note !== null).toBe(gate.showNote);
  });
});

describe('the published pages', () => {
  it('are exactly the entries that record their own ASPCA listing', () => {
    const listed = PET_TOXICITY.filter((e) => e.aspcaListing !== undefined).map((e) => e.slug);
    expect(PLANT_SAFETY_PAGES.map((p) => p.slug)).toEqual(listed);
    expect(PLANT_SAFETY_PAGES.length).toBeGreaterThan(0);
  });

  it('never publish an uncited entry, including ones the table marks non-toxic', () => {
    // Since 2026-10-02 every row the table records as non-toxic carries its
    // listing, so the non-toxic-but-uncited case is held by a fixture.
    expect(
      toPlantSafetyPage({
        ...FIXTURE,
        cats: 'non-toxic',
        dogs: 'non-toxic',
        aspcaListing: undefined,
      })
    ).toBeNull();
    const uncited = PET_TOXICITY.filter((e) => e.aspcaListing === undefined);
    expect(uncited.map((e) => e.slug)).toEqual(['zz-plant']);
    for (const entry of uncited) expect(findPlantSafetyPage(entry.slug)).toBeUndefined();
  });

  it('are found case-insensitively, as React Router matches', () => {
    const [first] = PLANT_SAFETY_PAGES;
    expect(findPlantSafetyPage(first!.slug.toUpperCase())?.slug).toBe(first!.slug);
    expect(findPlantSafetyPage('no-such-plant')).toBeUndefined();
  });

  it('cite the listing URL under the table’s ASPCA root', () => {
    for (const page of PLANT_SAFETY_PAGES) {
      for (const animal of ANIMALS) {
        const claim = page.claims[animal];
        if (claim.state === 'not-assessed') continue;
        expect(claim.source.url.startsWith(`${ASPCA_ANIMAL_POISON_CONTROL_URL}/`)).toBe(true);
      }
    }
  });
});

/**
 * Detailed pages (`aspcaListing.detailsRead`): the quoted listing and
 * extension fields, the horse verdict, similar and related plants, and the
 * FAQ. Same two standards: every rule fails closed, and the page's
 * implementation agrees with the gate's on every entry.
 */
const DETAILED = [
  'pothos',
  'monstera',
  'snake-plant',
  'spider-plant',
  'peace-lily',
  'aloe-vera',
  'bird-of-paradise',
  'christmas-cactus',
];

/** The page's details reduced to what the gate's version also returns. */
function comparable(details: PlantSafetyDetails | null) {
  if (!details) return null;
  return {
    horses: details.horses,
    listing: details.listing,
    extension: details.extension,
    alternatives: details.alternatives.map((p) => p.slug),
    related: details.related.map((p) => p.slug),
    anyToxic: details.anyToxic,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gateComparable(details: any) {
  if (!details) return null;
  const { reason: _reason, ...horses } = details.horses;
  return {
    ...details,
    horses,
    alternatives: details.alternatives.map((p: { slug: string }) => p.slug),
    related: details.related.map((p: { slug: string }) => p.slug),
  };
}

const TABLE = loadPetToxicityTable();
const gateDetails = (entry: LooseEntry) =>
  plantDetails(entry, { ...TABLE, aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL });
const pageDetails = (entry: LooseEntry) => plantSafetyDetailsFrom(entry, PLANT_SAFETY_PAGES);

const DETAILED_FIXTURE = (slug: string): LooseEntry =>
  structuredClone(PET_TOXICITY.find((e) => e.slug === slug)) as LooseEntry;

describe('detailed pages', () => {
  it('are exactly the eight pages whose listing details were read', () => {
    expect(
      PLANT_SAFETY_PAGES.filter((p) => plantSafetyDetails(p) !== null).map((p) => p.slug)
    ).toEqual(DETAILED);
  });

  it('every listed alternative and related plant resolves, so none is silently dropped', () => {
    for (const slug of DETAILED) {
      const entry = PET_TOXICITY.find((e) => e.slug === slug)!;
      const details = plantSafetyDetails(findPlantSafetyPage(slug)!)!;
      expect(
        details.alternatives.map((p) => p.slug),
        slug
      ).toEqual(entry.alternatives ?? []);
      expect(
        details.related.map((p) => p.slug),
        slug
      ).toEqual(entry.related ?? []);
      expect(details.extension, `${slug}: extension source`).not.toBeNull();
    }
  });

  it('shows a horse verdict only where the listing states one', () => {
    const withHorses = PLANT_SAFETY_PAGES.filter(
      (p) =>
        plantSafetyDetails(p)?.horses.state !== undefined &&
        plantSafetyDetails(p)!.horses.state !== 'not-assessed'
    ).map((p) => p.slug);
    expect(withHorses.sort()).toEqual(['aloe-vera', 'bird-of-paradise', 'christmas-cactus']);
  });
});

describe('detail rules fail closed', () => {
  it('no detailsRead: no details, in both implementations', () => {
    const entry = DETAILED_FIXTURE('aloe-vera');
    delete (entry.aspcaListing as Record<string, unknown>).detailsRead;
    expect(pageDetails(entry)).toBeNull();
    expect(gateDetails(entry)).toBeNull();
  });

  it('a horses field the listing does not state is not assessed', () => {
    const entry = DETAILED_FIXTURE('pothos');
    entry.horses = 'non-toxic';
    expect(pageDetails(entry)!.horses.state).toBe('not-assessed');
    expect(gateDetails(entry).horses.state).toBe('not-assessed');
  });

  it('an extension "non-toxic" tag never shows where the ASPCA verdict is not a cited non-toxic', () => {
    // The real spider plant data already carries one: NC State tags it
    // non-toxic for horses, and ASPCA's listing is silent on horses.
    expect(pageDetails(DETAILED_FIXTURE('spider-plant'))!.extension!.tags).toEqual([
      'cats',
      'dogs',
    ]);
    const entry = DETAILED_FIXTURE('pothos');
    (entry.extensionSource as Record<string, unknown>).tagged = {
      cats: 'non-toxic',
      dogs: 'non-toxic',
    };
    expect(pageDetails(entry)!.extension!.tags).toEqual([]);
    expect(gateDetails(entry).extension.tags).toEqual([]);
  });

  it('an extension source off the allowed origins is dropped', () => {
    const entry = DETAILED_FIXTURE('pothos');
    (entry.extensionSource as Record<string, unknown>).url = 'https://example.com/plants/pothos/';
    expect(pageDetails(entry)!.extension).toBeNull();
    expect(gateDetails(entry).extension).toBeNull();
  });

  it('an alternative whose own page is not non-toxic for cats and dogs is dropped', () => {
    const entry = DETAILED_FIXTURE('aloe-vera');
    entry.alternatives = ['jade-plant', 'lily', 'haworthia', 'no-such-plant', 'aloe-vera'];
    expect(pageDetails(entry)!.alternatives.map((p) => p.slug)).toEqual(['haworthia']);
    expect(gateDetails(entry).alternatives.map((p: { slug: string }) => p.slug)).toEqual([
      'haworthia',
    ]);
  });

  it('a blank quoted field is left out rather than shown empty', () => {
    const entry = DETAILED_FIXTURE('snake-plant');
    (entry.aspcaListing as Record<string, unknown>).clinicalSigns = '  ';
    const expected = ['additionalCommonNames', 'family', 'toxicPrinciples', 'listingAdvice'];
    expect(pageDetails(entry)!.listing.map((f) => f.field)).toEqual(expected);
    expect(gateDetails(entry).listing.map((f: { field: string }) => f.field)).toEqual(expected);
  });
});

describe('the page details and FAQ agree with the gate', () => {
  const catalog = readCatalog();
  const t = i18next.getFixedT('en') as unknown as (k: string, o?: Record<string, string>) => string;

  it.each(PET_TOXICITY.map((e) => [e.slug, e] as const))('%s', (_slug, entry) => {
    const mine = pageDetails(entry as LooseEntry);
    const gate = gateDetails(entry as LooseEntry);
    expect(comparable(mine)).toEqual(gateComparable(gate));
    const page = toPlantSafetyPage(entry as LooseEntry);
    if (!page) return;
    const faq = plantSafetyFaq(page, mine, t);
    expect(faq).toEqual(plantFaq(entry, gate, catalog, ASPCA_ANIMAL_POISON_CONTROL_URL));
  });

  it('asks the searched question per cited animal, then which parts, then what to do', () => {
    const page = findPlantSafetyPage('peace-lily')!;
    const faq = plantSafetyFaq(page, plantSafetyDetails(page), t);
    expect(faq.map((i) => i.question)).toEqual([
      'Is peace lily toxic to cats?',
      'Is peace lily toxic to dogs?',
      'Which parts of peace lily are poisonous?',
      'What should I do if my pet ate some peace lily?',
    ]);
    expect(faq[2]!.answer).toBe(
      'NC State Extension’s North Carolina Extension Gardener Plant Toolbox lists these parts ' +
        'of the plant as poisonous: Leaves. It gives that list under “Poisonous to Humans”, and ' +
        'the ASPCA verdicts on this page are the ones for pets.'
    );
    expect(faq[1]!.answer).toBe(
      'Yes. The ASPCA lists Peace Lily (Spathiphyllum) as toxic to dogs. Its listing gives the ' +
        'toxic principles as “Insoluble calcium oxalates” and the clinical signs as “Oral ' +
        'irritation, intense burning and irritation of mouth, tongue and lips, excessive drooling, ' +
        'vomiting, difficulty swallowing”.'
    );
  });

  it('asks which parts only with a quoted "Poison Part" on a page the ASPCA cites as toxic', () => {
    const asked = (entry: LooseEntry) => {
      const page = toPlantSafetyPage(entry)!;
      const mine = plantSafetyFaq(page, pageDetails(entry), t).map((i) => i.id);
      const gate = plantFaq(
        entry,
        gateDetails(entry),
        catalog,
        ASPCA_ANIMAL_POISON_CONTROL_URL
      ).map((i: { id: string }) => i.id);
      expect(mine).toEqual(gate);
      return mine.includes('parts');
    };
    expect(asked(DETAILED_FIXTURE('pothos'))).toBe(true);
    // Bird of paradise's extension page gives no "Poison Part", so no question.
    expect(asked(DETAILED_FIXTURE('bird-of-paradise'))).toBe(false);
    const blank = DETAILED_FIXTURE('pothos');
    (blank.extensionSource as Record<string, unknown>).poisonPart = ' ';
    expect(asked(blank)).toBe(false);
    // A "Poison Part" on a plant the ASPCA lists as non-toxic is never turned into a question.
    const safe = DETAILED_FIXTURE('spider-plant');
    (safe.extensionSource as Record<string, unknown>).poisonPart = 'Leaves';
    expect(asked(safe)).toBe(false);
  });
});
