/**
 * The "pick a common houseplant" shortcut in the first run.
 *
 * Measured on 2026-10-23: 37 of 43 households never added a plant. The first
 * run asked for a typed name first, and the shortest honest way to get
 * someone past that is to let them tap the plant they already own.
 *
 * Every entry is one of the published `/care/<slug>` guides, so the defaults
 * are the guide's own facts and not a second opinion:
 *
 *  - `scientificName` is the guide's, saved as the plant's species. It is the
 *    same in every language, so a Spanish speaker's plant still matches the
 *    species catalog and the pet-toxicity table.
 *  - `waterEveryDays` is the LOW end of the guide's "At a glance" watering
 *    range ("Every 7–10 days" → 7, "Every 2–3 weeks" → 14). The reminder is
 *    a prompt to check the soil, which every one of those guides says to do
 *    first, and the copy calls it a starting point the household can change.
 *
 * The display name is translated (`firstRun.picker.plants.<slug>`); the
 * English one matches the guide's common name. `commonPlants.test.ts` holds
 * all three to `CARE_GUIDES`, so a guide edit that moves a range fails here
 * rather than drifting. This file deliberately does not import `CARE_GUIDES`:
 * that would pull every guide's prose into the first run's chunk.
 *
 * Ten, not all 33: a two-column grid of ten fits a phone screen above the
 * "something else" form. These are the plants the care guides themselves
 * call the most common, and anything else is one field away.
 */
export interface CommonPlant {
  /** A published care-guide slug; also the i18n key for the display name. */
  slug: string;
  scientificName: string;
  /** First watering reminder, in days: the low end of the guide's range. */
  waterEveryDays: number;
}

export const COMMON_PLANTS: readonly CommonPlant[] = [
  { slug: 'pothos', scientificName: 'Epipremnum aureum', waterEveryDays: 7 },
  { slug: 'snake-plant', scientificName: 'Dracaena trifasciata', waterEveryDays: 14 },
  { slug: 'monstera', scientificName: 'Monstera deliciosa', waterEveryDays: 7 },
  { slug: 'spider-plant', scientificName: 'Chlorophytum comosum', waterEveryDays: 7 },
  { slug: 'peace-lily', scientificName: 'Spathiphyllum', waterEveryDays: 7 },
  { slug: 'zz-plant', scientificName: 'Zamioculcas zamiifolia', waterEveryDays: 14 },
  { slug: 'aloe-vera', scientificName: 'Aloe vera', waterEveryDays: 14 },
  { slug: 'orchid', scientificName: 'Phalaenopsis', waterEveryDays: 7 },
  { slug: 'fiddle-leaf-fig', scientificName: 'Ficus lyrata', waterEveryDays: 7 },
  { slug: 'jade-plant', scientificName: 'Crassula ovata', waterEveryDays: 14 },
];
