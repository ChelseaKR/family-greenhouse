import type { ComponentType } from 'react';
import RememberingToWater from './remembering-to-water';
import SharingPlantCare from './sharing-plant-care';
import LowWaterPlants from './low-water-plants';
import MovingWithPlants from './moving-with-plants';
import PetSafeHardToKill from './pet-safe-hard-to-kill';
import CommonToxicHouseplants from './common-toxic-houseplants';
import { POST_META, type BlogPostMeta } from './meta.ts';

/**
 * Blog post manifest. Adding a post means dropping a TSX file in this
 * directory, importing it here, appending its metadata to `POST_META` in
 * `meta.ts` (whose `body` field names that file), and adding the file's
 * basename to `BODIES` below. The slug is the URL
 * fragment (`/blog/<slug>`), the date is ISO-8601, and the description
 * double-duties as the listing preview text and (unless a shorter
 * `metaDescription` is given) the meta description.
 *
 * Metadata lives in `meta.ts` rather than here because the build-time
 * prerenderer and the sitemap generator run under plain Node and must read a
 * post's title, description and date without importing React components.
 *
 * Posts ship as React components rather than markdown so:
 *  - they share the app's design tokens (no MDX runtime / theming gap),
 *  - we don't take an XSS risk on `dangerouslySetInnerHTML`,
 *  - Claude can author TSX as readily as markdown per the marketing
 *    plan's content pipeline.
 */
export type { BlogPostMeta } from './meta.ts';
export { POST_META, postMetaDescription } from './meta.ts';

export interface BlogPost extends BlogPostMeta {
  Component: ComponentType;
}

const BODIES: Record<string, ComponentType> = {
  'remembering-to-water': RememberingToWater,
  'sharing-plant-care': SharingPlantCare,
  'low-water-plants': LowWaterPlants,
  'moving-with-plants': MovingWithPlants,
  'pet-safe-hard-to-kill': PetSafeHardToKill,
  'common-toxic-houseplants': CommonToxicHouseplants,
};

export const POSTS: BlogPost[] = POST_META.map((meta) => {
  const Component = BODIES[meta.body];
  // A post with metadata but no body would render an empty article at a URL
  // the sitemap advertises. Fail at import time instead.
  if (!Component) throw new Error(`Blog post "${meta.slug}" has no body module "${meta.body}"`);
  return { ...meta, Component };
});

export function findPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
