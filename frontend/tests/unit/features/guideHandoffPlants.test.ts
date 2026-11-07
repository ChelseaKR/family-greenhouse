import { describe, expect, it } from 'vitest';
import { COMMON_PLANTS } from '@/features/onboarding/commonPlants';
import { GUIDE_HANDOFF_PLANTS } from '@/features/onboarding/guideHandoffPlants';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { CARE_GUIDE_SLUGS } from '@/features/care/careGuideSlugs';
import { sentenceStartName } from '@/features/care/plantNames';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';

/**
 * The guide plants carried through sign-up without a first-run tile. Each
 * first reminder must be the low end of an interval the plant's own guide
 * states and a cited source gives, so a guide edit that drops or moves that
 * interval fails here instead of leaving a reminder nobody can trace.
 */

/** The phrase each guide's water line states, and the days it means. */
const CITED_INTERVAL: Record<string, { phrase: RegExp; days: number }> = {
  // UF/IFAS Gardening Solutions, "Rosemary Topiaries": "about once every week or so".
  rosemary: { phrase: /about once a week/i, days: 7 },
};

const enNames = en.firstRun.picker.plants as Record<string, string>;
const esNames = es.firstRun.picker.plants as Record<string, string>;

describe('GUIDE_HANDOFF_PLANTS', () => {
  it.each(GUIDE_HANDOFF_PLANTS.map((p) => [p.slug, p] as const))(
    '%s matches its published guide and the interval it cites',
    (slug, pick) => {
      expect(CARE_GUIDE_SLUGS.has(slug), `no /care/${slug} guide`).toBe(true);
      const guide = CARE_GUIDES.find((g) => g.slug === slug)!;
      expect(pick.scientificName).toBe(guide.scientificName);

      const cited = CITED_INTERVAL[slug];
      expect(cited, `${slug}: no cited interval recorded for this entry`).toBeDefined();
      expect(guide.quickFacts.water).toMatch(cited!.phrase);
      expect(pick.waterEveryDays).toBe(cited!.days);

      expect(enNames[slug]).toBe(sentenceStartName(guide.commonName));
      expect(esNames[slug]).toBeTruthy();
      expect(esNames[slug]).not.toBe(enNames[slug]);
    }
  );

  it('stays separate from the ten first-run tiles', () => {
    expect(COMMON_PLANTS).toHaveLength(10);
    for (const pick of GUIDE_HANDOFF_PLANTS) {
      expect(
        COMMON_PLANTS.some((p) => p.slug === pick.slug),
        pick.slug
      ).toBe(false);
    }
    const slugs = GUIDE_HANDOFF_PLANTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('carries no guide that gives a soil rule and no day count', () => {
    // Of the five guides added 2026-11-05, only rosemary is carried. The air
    // plant is held back because the first run's copy says "check the soil".
    const slugs = GUIDE_HANDOFF_PLANTS.map((p) => p.slug);
    for (const slug of ['ponytail-palm', 'areca-palm', 'schefflera', 'air-plant']) {
      expect(slugs, slug).not.toContain(slug);
    }
  });

  it('negative control: a guide whose water line drops the interval fails the match', () => {
    const rosemary = CARE_GUIDES.find((g) => g.slug === 'rosemary')!;
    expect(rosemary.quickFacts.water).toMatch(CITED_INTERVAL.rosemary!.phrase);
    const doctored = 'When the soil is dry to the touch';
    expect(doctored).not.toMatch(CITED_INTERVAL.rosemary!.phrase);
  });
});
