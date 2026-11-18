import type { CommonPlant } from './commonPlants';

/**
 * Care-guide plants the first run can carry through sign-up although they are
 * not among its ten one-tap tiles (`COMMON_PLANTS`).
 *
 * A visitor on `/care/<slug>` for one of these lands on
 * `/register?plant=<slug>`, and the first run lists the plant first, the same
 * as for a tile plant (`guidePlantHandoff.ts`). Keeping them out of
 * `COMMON_PLANTS` keeps the tile grid at ten for everyone else.
 *
 * A plant goes here only when its guide states a watering interval that a
 * cited source gives; `waterEveryDays` is the low end of that interval. A
 * guide that gives a soil rule and no day count gets no entry, and its
 * visitors get plain `/register`: nothing is guessed. `guideHandoffPlants.test`
 * holds each entry to its guide.
 *
 *  - rosemary (2026-11-05): UF/IFAS Gardening Solutions gives "about once
 *    every week or so" for the holiday rosemary topiary, so 7 days.
 *
 * Not here yet: the air plant. Its sources agree on about once a week, but
 * the first run's copy says the reminder is to "check the soil", and an air
 * plant has no soil. It can be added once that line can say "water".
 */
export const GUIDE_HANDOFF_PLANTS: readonly CommonPlant[] = [
  { slug: 'rosemary', scientificName: 'Salvia rosmarinus', waterEveryDays: 7 },
];
