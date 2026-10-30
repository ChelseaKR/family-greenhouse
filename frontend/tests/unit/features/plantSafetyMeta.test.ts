/**
 * The `<title>` and meta description of every `/pet-safe/<slug>` page.
 *
 * Searchers write "poisonous" where the old description said only "toxic", and
 * the verdict belongs where a searcher reads it first. This holds the head to
 * a length budget a SERP will not truncate, makes each page's title distinct,
 * and checks the verdict words in the description against the ASPCA table
 * itself (not against the page's own rule): a toxic plant must say "Toxic", a
 * non-toxic one "Non-toxic", and an animal the table does not cite must say
 * "Not assessed", never "safe".
 *
 * Each negative control applies a sabotage, asserts the sabotage changed the
 * input, and then asserts the checker names the fault.
 */
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';

import { PET_TOXICITY } from '../../../../backend/src/models/petToxicity';
import { PLANT_SAFETY_PAGES, plantSafetyMeta } from '@/features/petsafe/plantSafetyPages';
import type { PlantSafetyPage } from '@/features/petsafe/plantSafetyPages';
import enCatalog from '@/i18n/locales/en/translation.json';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { HEAD_QUESTION, SAFETY_WORDING } from '../../../scripts/check-plant-safety-pages.mjs';

const MAX_TITLE = 60;
const MAX_DESCRIPTION = 155;

/** The words the ASPCA table's two states are shown as. Written out, not imported. */
const WORDS = { toxic: 'Toxic', 'non-toxic': 'Non-toxic', notAssessed: 'Not assessed' } as const;

/** What the table itself says for one animal, independent of the page's rule. */
function tableWord(slug: string, animal: 'cats' | 'dogs'): string {
  const entry = PET_TOXICITY.find((e) => e.slug === slug)!;
  const recorded = entry[animal];
  const listed = entry.aspcaListing?.listed?.[animal];
  if ((recorded === 'toxic' || recorded === 'non-toxic') && listed === recorded) {
    return WORDS[recorded];
  }
  return WORDS.notAssessed;
}

function headFor(page: PlantSafetyPage) {
  const meta = plantSafetyMeta(page, i18next.t.bind(i18next) as never);
  return { title: meta.title!, description: meta.description! };
}

/** Every fault in one page's head; empty means it passes. */
function faults(slug: string, title: string, description: string): string[] {
  const out: string[] = [];
  if (title.length > MAX_TITLE) out.push(`title is ${title.length} characters`);
  if (description.length > MAX_DESCRIPTION) {
    out.push(`description is ${description.length} characters`);
  }
  if (!/poisonous or safe for pets\?/.test(description)) out.push('description lacks the question');
  const m = description.match(/ Cats: ([^.]+)\. Dogs: ([^.]+)\.$/);
  if (!m) {
    out.push('description has no "Cats: ... Dogs: ..." verdicts');
  } else {
    for (const [animal, shown] of [
      ['cats', m[1]],
      ['dogs', m[2]],
    ] as const) {
      const expected = tableWord(slug, animal);
      if (shown !== expected) out.push(`${animal} reads "${shown}", the table says "${expected}"`);
    }
  }
  return out;
}

describe('the pet-safe page heads', () => {
  const heads = PLANT_SAFETY_PAGES.map((page) => ({ page, ...headFor(page) }));

  it('covers every published page', () => {
    expect(heads.length).toBeGreaterThanOrEqual(39);
  });

  it('keeps every title within 60 characters and every description within 155', () => {
    const over = heads.flatMap(({ page, title, description }) =>
      faults(page.slug, title, description).filter((f) => /characters/.test(f))
    );
    expect(over).toEqual([]);
    const longest = Math.max(...heads.map((h) => h.title.length));
    expect(longest).toBeLessThanOrEqual(MAX_TITLE);
  });

  it('gives every page a distinct title and a distinct description', () => {
    expect(new Set(heads.map((h) => h.title)).size).toBe(heads.length);
    expect(new Set(heads.map((h) => h.description)).size).toBe(heads.length);
  });

  it('asks the searcher’s question in both words, in the title and the description', () => {
    for (const { page, title, description } of heads) {
      expect(title, page.slug).toMatch(/^Is .+ toxic to cats and dogs\? ASPCA verdict$/);
      expect(description, page.slug).toContain('poisonous or safe for pets?');
    }
  });

  it('states each animal’s verdict exactly as the ASPCA table records it', () => {
    for (const { page, title, description } of heads) {
      expect(faults(page.slug, title, description), page.slug).toEqual([]);
    }
  });

  it('says "Not assessed" for an animal the table does not cite, never "safe"', () => {
    const uncited = heads.filter(({ page }) =>
      (['cats', 'dogs'] as const).some((a) => page.claims[a].state === 'not-assessed')
    );
    for (const { page, description } of uncited) {
      expect(description, page.slug).toContain('Not assessed');
      // The only "safe" a description may carry is the question itself.
      expect(description.replace(HEAD_QUESTION, ''), page.slug).not.toMatch(SAFETY_WORDING);
    }
  });

  it('the English catalog template carries no safety claim beyond the question', () => {
    const template = enCatalog.plantSafetyPage.metaDescription;
    expect(template.replace(HEAD_QUESTION, '')).not.toMatch(SAFETY_WORDING);
    expect(enCatalog.plantSafetyPage.metaTitle).not.toMatch(SAFETY_WORDING);
  });
});

describe('negative controls: the checker can fail', () => {
  const toxic = PLANT_SAFETY_PAGES.find(
    (p) => p.claims.cats.state === 'toxic' && p.claims.dogs.state === 'toxic'
  )!;
  const base = headFor(toxic);

  it('control 0: the unsabotaged head passes', () => {
    expect(faults(toxic.slug, base.title, base.description)).toEqual([]);
  });

  it('flags a "safe" verdict on a toxic plant', () => {
    const sabotaged = base.description.replace('Cats: Toxic', 'Cats: Safe');
    expect(sabotaged).not.toBe(base.description);
    expect(faults(toxic.slug, base.title, sabotaged)).toEqual([
      'cats reads "Safe", the table says "Toxic"',
    ]);
    const nonToxic = base.description.replace('Cats: Toxic', 'Cats: Non-toxic');
    expect(nonToxic).not.toBe(base.description);
    expect(faults(toxic.slug, base.title, nonToxic)).toHaveLength(1);
  });

  it('flags an over-long title', () => {
    const sabotaged = `${base.title} and a few more words to push it past the cut`;
    expect(sabotaged.length).toBeGreaterThan(MAX_TITLE);
    expect(faults(toxic.slug, sabotaged, base.description)).toEqual([
      `title is ${sabotaged.length} characters`,
    ]);
  });

  it('flags a description that is over-long', () => {
    const sabotaged = base.description.replace('What the ASPCA lists.', `${'x'.repeat(120)}.`);
    expect(sabotaged).not.toBe(base.description);
    expect(faults(toxic.slug, base.title, sabotaged)).toContainEqual(
      expect.stringMatching(/^description is \d+ characters$/)
    );
  });

  it('flags a missing verdict', () => {
    const sabotaged = base.description.replace(' Dogs: Toxic.', '');
    expect(sabotaged).not.toBe(base.description);
    expect(faults(toxic.slug, base.title, sabotaged)).toContain(
      'description has no "Cats: ... Dogs: ..." verdicts'
    );
  });

  it('flags "Not assessed" swapped for a verdict the table does not hold, and the reverse', () => {
    const swapped = base.description.replace('Dogs: Toxic', 'Dogs: Not assessed');
    expect(swapped).not.toBe(base.description);
    expect(faults(toxic.slug, base.title, swapped)).toEqual([
      'dogs reads "Not assessed", the table says "Toxic"',
    ]);
  });

  it('the exemption covers the question only: a statement of safety still matches', () => {
    expect('Is X poisonous or safe for pets?'.replace(HEAD_QUESTION, '')).not.toMatch(
      SAFETY_WORDING
    );
    expect('X is safe for pets.'.replace(HEAD_QUESTION, '')).toMatch(SAFETY_WORDING);
    expect('X is poisonous or safe for pets.'.replace(HEAD_QUESTION, '')).toMatch(SAFETY_WORDING);
  });
});
