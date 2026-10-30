import { describe, expect, it } from 'vitest';
import { COMMON_PLANTS } from '@/features/onboarding/commonPlants';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { sentenceStartName } from '@/features/care/plantNames';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';

/**
 * The shortcut's defaults are the care guides' own facts. These tests are
 * what keeps them that way: a guide edit that moves a watering range, renames
 * a plant or changes its scientific name fails here instead of drifting.
 */

/** The guide's "At a glance" watering range in days, or null if it has none. */
function wateringRangeDays(water: string): [number, number] | null {
  const range = /every (\d+)–(\d+) (days|weeks)/iu.exec(water);
  if (range) {
    const unit = range[3] === 'weeks' ? 7 : 1;
    return [Number(range[1]) * unit, Number(range[2]) * unit];
  }
  if (/once a week/u.test(water)) return [7, 7];
  return null;
}

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
      expect(range, `unparseable watering line: ${guide!.quickFacts.water}`).not.toBeNull();
      // The low end of the range, exactly.
      expect(pick.waterEveryDays).toBe(range![0]);

      expect(enNames[pick.slug]).toBe(sentenceStartName(guide!.commonName));
      expect(esNames[pick.slug]).toBeTruthy();
    }
  );

  it('has a name in both catalogs for every pick, and no stray names', () => {
    const slugs = COMMON_PLANTS.map((p) => p.slug).sort();
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
    const snake = CARE_GUIDES.find((g) => g.slug === 'snake-plant')!;
    expect(wateringRangeDays(snake.quickFacts.water)![0]).not.toBe(7);
  });
});
