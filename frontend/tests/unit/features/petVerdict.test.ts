import { describe, expect, it } from 'vitest';
import i18next from 'i18next';

import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import {
  asPetVerdict,
  petCaution,
  petOutcome,
  petSummaryLine,
  verdictLabelKey,
  type PetVerdict,
} from '@/features/petsafe/petVerdict';
import { cautionFor } from '@/features/care/careToxicity';
import { claimFor, type LooseEntry } from '@/features/petsafe/plantSafetyPages';
import { PET_TOXICITY, citedVerdict } from '../../../../backend/src/models/petToxicity';

/**
 * The single place an API verdict becomes words. The rule under test: the
 * words "Non-toxic" / "Listed as non-toxic" are reachable ONLY from the
 * literal 'non-toxic'; anything else, including values no type allows, reads
 * as unknown.
 */

async function translator(lng: 'en' | 'es') {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    resources: { en: { translation: en }, es: { translation: es } },
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance) as (key: string, options?: Record<string, string>) => string;
}

/** Inputs a server, a cache or a typo could produce. */
const WIRE_VALUES: unknown[] = [
  'toxic',
  'non-toxic',
  'unknown',
  'safe',
  'Non-toxic',
  'nontoxic',
  '',
  undefined,
  null,
  42,
];

/**
 * The oracle: given a renderer from a raw value to a label, list every input
 * it calls "Non-toxic" although the input is not the literal 'non-toxic'.
 */
function falseAllClears(render: (value: unknown) => string): unknown[] {
  return WIRE_VALUES.filter((v) => render(v) === 'Non-toxic' && v !== 'non-toxic');
}

describe('asPetVerdict and petOutcome', () => {
  it('keeps only the literal verdicts; everything else is unknown', () => {
    expect(WIRE_VALUES.map(asPetVerdict)).toEqual([
      'toxic',
      'non-toxic',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('is safe only when both animals are an explicit non-toxic', () => {
    const v = (x: string) => x as PetVerdict;
    expect(petOutcome(v('non-toxic'), v('non-toxic'))).toBe('safe');
    expect(petOutcome(v('non-toxic'), v('unknown'))).toBe('unknown');
    expect(petOutcome(v('unknown'), v('unknown'))).toBe('unknown');
    expect(petOutcome(v('toxic'), v('unknown'))).toBe('harmful');
    expect(petOutcome(v('safe'), v('non-toxic'))).toBe('unknown');
    expect(petOutcome(v('non-toxic'), v(undefined as never))).toBe('unknown');
  });
});

describe('verdict labels', () => {
  it('never call anything but the literal non-toxic "Non-toxic"', async () => {
    const t = await translator('en');
    expect(falseAllClears((v) => t(verdictLabelKey(v as PetVerdict)))).toEqual([]);
    expect(t(verdictLabelKey('unknown'))).toBe('Unknown');
  });

  it('negative control: the old checker-card ternary fails the same oracle', () => {
    // What PetSafePage rendered before this change. If this ever stops
    // failing the oracle, the oracle has gone blind and the test above means
    // nothing.
    const oldTernary = (v: unknown) => (v === 'toxic' ? 'Toxic' : 'Non-toxic');
    expect(falseAllClears(oldTernary)).toEqual([
      'unknown',
      'safe',
      'Non-toxic',
      'nontoxic',
      '',
      undefined,
      null,
      42,
    ]);
  });

  it('the summary line says "Listed as non-toxic" only for two literal non-toxics', async () => {
    const t = await translator('en');
    const safe = t('sitterBrief.petSafe');
    for (const cats of WIRE_VALUES) {
      for (const dogs of WIRE_VALUES) {
        const line = petSummaryLine(t, cats as PetVerdict, dogs as PetVerdict);
        const shouldBeSafe = cats === 'non-toxic' && dogs === 'non-toxic';
        expect(line === safe, `${String(cats)}/${String(dogs)}`).toBe(shouldBeSafe);
      }
    }
  });
});

describe('the caution line', () => {
  it('reads exactly as the care page’s cautionFor, in English', async () => {
    const t = await translator('en');
    for (const name of ['ZZ plant', 'Pothos', 'English ivy', 'Fixture Plant']) {
      expect(petCaution(t, name, 'unknown', 'unknown')).toBe(cautionFor(name, ['cats', 'dogs']));
      expect(petCaution(t, name, 'non-toxic', 'unknown')).toBe(cautionFor(name, ['dogs']));
      expect(petCaution(t, name, 'unknown', 'toxic')).toBe(cautionFor(name, ['cats']));
      expect(petCaution(t, name, 'toxic', 'non-toxic')).toBeNull();
    }
  });

  it('is real Spanish, with the same number, and never reads as safe', async () => {
    const [tEn, tEs] = await Promise.all([translator('en'), translator('es')]);
    for (const [cats, dogs] of [
      ['unknown', 'unknown'],
      ['non-toxic', 'unknown'],
      ['unknown', 'toxic'],
    ] as const) {
      const english = petCaution(tEn, 'ZZ plant', cats, dogs)!;
      const spanish = petCaution(tEs, 'ZZ plant', cats, dogs)!;
      expect(spanish).not.toBe(english);
      expect(spanish).toContain('(888-426-4435)');
      expect(spanish).toMatch(/ASPCA/);
      expect(spanish).not.toMatch(/no tóxica|segura|non-toxic|isn’t/i);
    }
  });

  it('treats an unexpected value as unknown, so it gets the caution', async () => {
    const t = await translator('en');
    expect(petCaution(t, 'ZZ plant', 'safe' as PetVerdict, 'safe' as PetVerdict)).toBe(
      cautionFor('ZZ plant', ['cats', 'dogs'])
    );
  });
});

describe('one citation rule, front and back', () => {
  const LISTING = {
    title: 'Fixture',
    scientificName: 'Fixtura plantae',
    path: '/toxic-and-non-toxic-plants/fixture',
    listed: { cats: 'non-toxic', dogs: 'toxic' },
  };
  const FIXTURES: LooseEntry[] = [
    { cats: 'non-toxic', dogs: 'toxic', aspcaListing: LISTING },
    { cats: 'non-toxic', dogs: 'toxic', aspcaListing: undefined },
    { cats: 'non-toxic', dogs: 'toxic', aspcaListing: { ...LISTING, listed: {} } },
    { cats: 'toxic', dogs: 'toxic', aspcaListing: LISTING },
    { cats: 'safe', dogs: '', aspcaListing: LISTING },
    { cats: 'non-toxic', dogs: 'toxic', aspcaListing: { ...LISTING, path: '/elsewhere/fixture' } },
  ];

  it('the API (citedVerdict) and the pages (claimFor) agree on every row and fixture', () => {
    const asState = (verdict: string) => (verdict === 'unknown' ? 'not-assessed' : verdict);
    for (const entry of [...(PET_TOXICITY as LooseEntry[]), ...FIXTURES]) {
      for (const animal of ['cats', 'dogs'] as const) {
        expect(
          asState(citedVerdict(entry as never, animal)),
          `${String(entry.slug)} ${animal}`
        ).toBe(claimFor(entry, animal).state);
      }
    }
  });
});
