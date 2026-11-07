import { describe, expect, it } from 'vitest';
import { COMMON_PLANTS } from '@/features/onboarding/commonPlants';
import { GUIDE_HANDOFF_PLANTS } from '@/features/onboarding/guideHandoffPlants';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { sentenceStartName } from '@/features/care/plantNames';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';

/**
 * The shortcut's defaults follow the care guides where a guide states a day
 * range. These tests keep them that way: a guide edit that moves a watering
 * range, renames a plant or changes its scientific name fails here instead of
 * drifting.
 */

/** The guide's "At a glance" watering range in days, or null if it has none. */
function wateringRangeDays(water: string): [number, number] | null {
  const range = /every (\d+)–(\d+) (days|weeks)/iu.exec(water);
  if (range) {
    const unit = range[3] === 'weeks' ? 7 : 1;
    return [Number(range[1]) * unit, Number(range[2]) * unit];
  }
  if (/once a week/iu.test(water)) return [7, 7];
  const weeks = /every (\d+) weeks/iu.exec(water);
  if (weeks) return [Number(weeks[1]) * 7, Number(weeks[1]) * 7];
  return null;
}

/**
 * Picks whose guide, since the 2026-11-03 source check, gives a soil rule and
 * no day count. Their first reminder is the earlier default and is NOT a cited
 * fact; changing it is a product decision, not a guide edit.
 */
const NO_GUIDE_INTERVAL: Record<string, number> = {
  pothos: 7,
  'snake-plant': 14,
  monstera: 7,
  'spider-plant': 7,
  'peace-lily': 7,
  'aloe-vera': 14,
  'fiddle-leaf-fig': 7,
  'jade-plant': 14,
};

const enNames = en.firstRun.picker.plants as Record<string, string>;
const esNames = es.firstRun.picker.plants as Record<string, string>;

describe('COMMON_PLANTS', () => {
  it.each(COMMON_PLANTS.map((p) => [p.slug, p] as const))(
    '%s matches its published care guide',
    (_slug, pick) => {
      const guide = CARE_GUIDES.find((g) => g.slug === pick.slug);
      expect(guide, `no /care/${pick.slug} guide`).toBeDefined();
      expect(pick.scientificName).toBe(guide!.scientificName);

      const range = wateringRangeDays(guide!.quickFacts.water);
      if (NO_GUIDE_INTERVAL[pick.slug] !== undefined) {
        // The cited guide gives a soil rule, not a day count; the default is
        // the earlier one, pinned so it cannot drift silently.
        expect(range, `${pick.slug} now states a range: use it`).toBeNull();
        expect(pick.waterEveryDays).toBe(NO_GUIDE_INTERVAL[pick.slug]);
      } else {
        expect(range, `unparseable watering line: ${guide!.quickFacts.water}`).not.toBeNull();
        // The low end of the range, exactly.
        expect(pick.waterEveryDays).toBe(range![0]);
      }

      expect(enNames[pick.slug]).toBe(sentenceStartName(guide!.commonName));
      expect(esNames[pick.slug]).toBeTruthy();
    }
  );

  it('has a name in both catalogs for every pick, and no stray names', () => {
    // The catalogs also name the guide plants that can be carried through
    // sign-up without being a tile (guideHandoffPlants.test checks those).
    const slugs = [...COMMON_PLANTS, ...GUIDE_HANDOFF_PLANTS].map((p) => p.slug).sort();
    expect(Object.keys(enNames).sort()).toEqual(slugs);
    expect(Object.keys(esNames).sort()).toEqual(slugs);
  });

  it('has no duplicates', () => {
    expect(new Set(COMMON_PLANTS.map((p) => p.slug)).size).toBe(COMMON_PLANTS.length);
  });

  it('rejects a default that is not the low end of its range (negative control)', () => {
    // The parser the per-plant test leans on must actually read a range: a
    // parser that returned null or [0, 0] would make every assertion above
    // vacuous or wrong.
    expect(wateringRangeDays('Every 2–3 weeks; let the soil dry out')).toEqual([14, 21]);
    expect(wateringRangeDays('Every 7–10 days, when dry')).toEqual([7, 10]);
    expect(wateringRangeDays('Keep evenly moist')).toBeNull();
    expect(wateringRangeDays('About every 2 weeks in summer')).toEqual([14, 14]);
    const zz = CARE_GUIDES.find((g) => g.slug === 'zz-plant')!;
    expect(wateringRangeDays(zz.quickFacts.water)![0]).not.toBe(7);
  });
});
