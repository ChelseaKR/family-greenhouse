/**
 * A short "Holiday plants" list of care guides, for the home page and the /care
 * index.
 *
 * Built 2026-11-15 and switched on the same day, once Chelsea approved the
 * heading on these two pages and the Spanish names. The links' words are the
 * guides' own names. Setting `HOLIDAY_CARE_GUIDES_ON` to false removes the
 * list from both pages (and fails the "is switched on" test in
 * holidayCareGuides.test.tsx, which then needs updating with it).
 *
 * Why these pages and these plants (fg-seo-data-2026-11-15, actions 1 and 4):
 * the only care pages in the US top 10 are less-common and holiday plants, and
 * paperwhite and rosemary had not been crawled at all. The home page and /care
 * are pages Google crawls and shows.
 *
 * The heading reuses the /pet-safe hub's existing "Holiday plants" label
 * (`petSafeSpecies.holidayHeading`, Spanish "Plantas navideñas"). The names are
 * catalog strings (`careHolidayGuides.*`): in English each is its guide's own
 * `commonName` (holidayCareGuides.test.tsx fails if one drifts), and in
 * Spanish each is the approved name, since the Spanish home page may show no
 * English (spanishFirstScreens.test.tsx).
 * They are not read from careGuides.ts, which would pull the guide data into
 * the home page's bundle.
 */
export const HOLIDAY_CARE_GUIDES_ON = true;

export const HOLIDAY_CARE_GUIDES = [
  { slug: 'amaryllis', nameKey: 'careHolidayGuides.amaryllis' },
  { slug: 'paperwhite', nameKey: 'careHolidayGuides.paperwhite' },
  { slug: 'poinsettia', nameKey: 'careHolidayGuides.poinsettia' },
  { slug: 'christmas-cactus', nameKey: 'careHolidayGuides.christmasCactus' },
  { slug: 'cyclamen', nameKey: 'careHolidayGuides.cyclamen' },
  { slug: 'rosemary', nameKey: 'careHolidayGuides.rosemary' },
] as const;

// Not on /pet-safe/peace-lily, the third page the report names: every line of
// text on a plant-safety page must come from the pet-toxicity table or the
// catalog (scripts/check-plant-safety-pages.mjs, rule 3), and a guide's name
// is neither, so the build would reject the list there.
