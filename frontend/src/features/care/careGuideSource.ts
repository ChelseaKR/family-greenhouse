import { CARE_GUIDES, type CareGuide } from './careGuides';
import { toCareGuideIndexEntry, type CareGuideIndexEntry } from './careGuideIndex';

/**
 * Where the app gets care-guide content from. Import careGuideContent.ts, not
 * this module.
 *
 * In the dev server, the tests and the SSR build that prerenders the public
 * pages, this module is what runs: every guide is in it, so a guide page
 * renders synchronously.
 *
 * In the browser build, `careGuideContent()` in vite.careGuideContent.ts
 * replaces this module with one that has the same exports, built from this
 * module's own values: CARE_GUIDE_INDEX as a literal, and a
 * `bundledCareGuide` that always returns undefined. The full guides (about
 * 230 kB of prose) then never reach the JavaScript bundle; a guide page reads
 * its guide from the JSON its prerendered HTML carries, or fetches that HTML.
 *
 * Keep the exports of this module and of the generated one in step:
 * tests/unit/features/careGuideContent.test.ts compares them.
 */

/** Every published guide, in CARE_GUIDES order, reduced to its index fields. */
export const CARE_GUIDE_INDEX: readonly CareGuideIndexEntry[] =
  CARE_GUIDES.map(toCareGuideIndexEntry);

/** The full guide when this build carries the guides in its bundle, else undefined. */
export function bundledCareGuide(slug: string): CareGuide | undefined {
  return CARE_GUIDES.find((guide) => guide.slug === slug);
}
