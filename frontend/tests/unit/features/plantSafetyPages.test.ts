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

import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
} from '../../../../backend/src/models/petToxicity';
import {
  ANIMALS,
  PLANT_SAFETY_PAGES,
  claimFor,
  findPlantSafetyPage,
  toPlantSafetyPage,
  type Animal,
  type LooseEntry,
} from '@/features/petsafe/plantSafetyPages';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { claimFor as gateClaimFor, plantPage } from '../../../scripts/pet-toxicity-table.mjs';

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
    const uncited = PET_TOXICITY.filter((e) => e.aspcaListing === undefined);
    expect(uncited.some((e) => e.cats === 'non-toxic')).toBe(true); // e.g. spider plant
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
