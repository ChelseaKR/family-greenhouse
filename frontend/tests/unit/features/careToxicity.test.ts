import { describe, expect, it } from 'vitest';

import { CARE_GUIDES, findCareGuide } from '@/features/care/careGuides';
import {
  careToxicity,
  careToxicityFrom,
  nameInSentence,
  sentenceName,
} from '@/features/care/careToxicity';
import type { LooseEntry } from '@/features/petsafe/plantSafetyPages';

/**
 * The care pages' pet answer comes from the cited table, never from a
 * hand-typed line. These cases feed `careToxicityFrom` rows that are fine,
 * missing, blank or contradicted, and pin what each may publish.
 */

const GUIDE = { slug: 'fixture-plant', commonName: 'Fixture Plant' };

const LISTING = {
  title: 'Fixture Plant',
  scientificName: 'Fixtura plantae',
  path: '/toxic-and-non-toxic-plants/fixture-plant',
  listed: { cats: 'non-toxic', dogs: 'non-toxic' },
};

const CITED: LooseEntry = {
  slug: 'fixture-plant',
  commonName: 'Fixture plant',
  scientificName: 'Fixtura plantae',
  aliases: [],
  cats: 'non-toxic',
  dogs: 'non-toxic',
  note: 'A fixture note.',
  aspcaListing: LISTING,
};

describe('careToxicityFrom', () => {
  it('publishes a cited verdict, its source and the note, and marks it sourced', () => {
    const view = careToxicityFrom(GUIDE, [CITED]);
    expect(view.claims.cats.state).toBe('non-toxic');
    expect(view.claims.dogs.state).toBe('non-toxic');
    expect(view.sourced).toBe(true);
    expect(view.note).toBe('A fixture note.');
    // Fully cited: no caution line anywhere.
    expect(view.caution).toBeNull();
    expect(view.faq.q).toBe('Is a fixture plant toxic to cats and dogs?');
    expect(view.faq.a).toBe(
      'No. The ASPCA lists Fixture Plant (Fixtura plantae) as non-toxic to cats and dogs. A fixture note.'
    );
  });

  // Negative controls: each one breaks the citation in a different way, and
  // every one must land on "unknown" for the affected animal, never on the
  // recorded "non-toxic". If the rule loosened, these would read as safe.
  it.each([
    ['no table row at all', []],
    ['a row with no listing', [{ ...CITED, aspcaListing: undefined }]],
    ['a blank verdict', [{ ...CITED, cats: '', dogs: '' }]],
    ['a missing verdict', [{ ...CITED, cats: undefined, dogs: undefined }]],
    [
      'a listing that is silent on both animals',
      [{ ...CITED, aspcaListing: { ...LISTING, listed: {} } }],
    ],
    [
      'a listing that disagrees',
      [{ ...CITED, aspcaListing: { ...LISTING, listed: { cats: 'toxic', dogs: 'toxic' } } }],
    ],
    [
      'a listing path that is not an ASPCA plant page',
      [{ ...CITED, aspcaListing: { ...LISTING, path: 'https://example.com/fixture' } }],
    ],
  ] as [string, LooseEntry[]][])('%s: unknown, unsourced, no note', (_label, table) => {
    const view = careToxicityFrom(GUIDE, table);
    expect(view.claims.cats.state).toBe('not-assessed');
    expect(view.claims.dogs.state).toBe('not-assessed');
    expect(view.sourced).toBe(false);
    expect(view.note).toBeNull();
    expect(view.petSafePath).toBeNull();
    expect(view.caution).toBe(
      'Fixture plant isn’t on the ASPCA’s list, so we can’t give a verdict. Keep it out of reach of pets, and if a pet eats some, call your vet or the ASPCA Animal Poison Control Center (888-426-4435).'
    );
    expect(view.faq.a).toBe(view.caution);
    expect(view.faq.a).not.toMatch(/non-toxic|pet-safe|\bsafe\b/i);
  });

  it('publishes only the cited animal when the listing covers one', () => {
    const view = careToxicityFrom(GUIDE, [
      { ...CITED, aspcaListing: { ...LISTING, listed: { cats: 'non-toxic' } } },
    ]);
    expect(view.claims.cats.state).toBe('non-toxic');
    expect(view.claims.dogs.state).toBe('not-assessed');
    expect(view.sourced).toBe(false);
    // The table note speaks for both animals, so it waits until both are cited.
    expect(view.note).toBeNull();
    expect(view.caution).toBe(
      'The ASPCA’s list gives no verdict on fixture plant for dogs, so we can’t give one. Keep it out of reach of pets, and if a pet eats some, call your vet or the ASPCA Animal Poison Control Center (888-426-4435).'
    );
    expect(view.faq.a).toBe(
      `The ASPCA lists Fixture Plant (Fixtura plantae) as non-toxic to cats. For dogs, our source gives no verdict. ${view.caution}`
    );
  });
});

describe('careToxicity over the real table', () => {
  it('cites every guide except the ZZ plant, which the ASPCA does not list', () => {
    const unsourced = CARE_GUIDES.filter((g) => !careToxicity(g).sourced).map((g) => g.slug);
    expect(unsourced).toEqual(['zz-plant']);
  });

  it('reads the heartleaf philodendron guide from the genus row and its listing', () => {
    const view = careToxicity(findCareGuide('heartleaf-philodendron')!);
    expect(view.claims.cats.state).toBe('toxic');
    expect(view.claims.cats.state !== 'not-assessed' && view.claims.cats.source.title).toBe(
      'Heartleaf Philodendron'
    );
    expect(view.petSafePath).toBe('/pet-safe/philodendron');
  });

  it('links every cited guide to its published /pet-safe page', () => {
    for (const g of CARE_GUIDES) {
      const view = careToxicity(g);
      if (view.sourced) expect(view.petSafePath, g.slug).toMatch(/^\/pet-safe\/[a-z-]+$/);
      else expect(view.petSafePath, g.slug).toBeNull();
    }
  });
});

describe('names in sentences', () => {
  it('keeps proper nouns and acronyms, and picks the article by sound', () => {
    expect(nameInSentence('Pothos')).toBe('a pothos');
    expect(nameInSentence('Aloe Vera')).toBe('an aloe vera');
    expect(nameInSentence('ZZ Plant')).toBe('a ZZ plant');
    expect(nameInSentence('English Ivy')).toBe('an English ivy');
    expect(sentenceName('Christmas Cactus')).toBe('Christmas cactus');
    expect(sentenceName('Bird of Paradise')).toBe('bird of paradise');
  });
});

describe('the caution line', () => {
  it('is the owner-approved wording for the ZZ plant', () => {
    expect(careToxicity(findCareGuide('zz-plant')!).caution).toBe(
      'ZZ plant isn’t on the ASPCA’s list, so we can’t give a verdict. Keep it out of reach of pets, and if a pet eats some, call your vet or the ASPCA Animal Poison Control Center (888-426-4435).'
    );
  });

  it('appears exactly for the guides with an unknown animal, and never reads as safe', () => {
    for (const g of CARE_GUIDES) {
      const view = careToxicity(g);
      const unknown =
        view.claims.cats.state === 'not-assessed' || view.claims.dogs.state === 'not-assessed';
      expect(view.caution !== null, g.slug).toBe(unknown);
      if (view.caution) {
        expect(view.caution, g.slug).not.toMatch(/non-toxic|pet-safe|\bsafe\b|harmless|fine/i);
        expect(view.caution, g.slug).toContain('(888-426-4435)');
      }
    }
  });

  it('negative control: a cited guide gains the caution when its listing is broken', () => {
    // Same plant both ways, so the only variable is the citation.
    const pothos = findCareGuide('pothos')!;
    const row = { ...CITED, slug: 'pothos', commonName: 'Pothos' };
    expect(careToxicityFrom(pothos, [row]).caution).toBeNull();
    const broken = careToxicityFrom(pothos, [{ ...row, aspcaListing: undefined }]);
    expect(broken.claims.cats.state).toBe('not-assessed');
    expect(broken.caution).toMatch(/^Pothos isn’t on the ASPCA’s list/);
  });
});
