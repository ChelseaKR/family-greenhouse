/**
 * The slugs of the published `/care/<slug>` guides, without their content.
 *
 * Pages outside the care feature (the `/pet-safe/<slug>` pages) link to a
 * plant's care guide when one exists. Importing `CARE_GUIDES` for that would
 * pull every guide's text into those pages' chunk, so they read this list
 * instead. `careGuideSlugs.test.ts` fails if it drifts from `CARE_GUIDES`.
 */
export const CARE_GUIDE_SLUGS: ReadonlySet<string> = new Set([
  'pothos',
  'snake-plant',
  'monstera',
  'spider-plant',
  'peace-lily',
  'heartleaf-philodendron',
  'zz-plant',
  'aloe-vera',
  'dieffenbachia',
  'calathea',
  'fiddle-leaf-fig',
  'rubber-plant',
  'bird-of-paradise',
  'anthurium',
  'chinese-evergreen',
  'jade-plant',
  'english-ivy',
  'boston-fern',
  'money-tree',
  'christmas-cactus',
  'parlor-palm',
  'orchid',
  'hoya',
  'nerve-plant',
]);

/** True when `/care/<slug>` is a published guide. */
export function hasCareGuide(slug: string): boolean {
  return CARE_GUIDE_SLUGS.has(slug);
}
