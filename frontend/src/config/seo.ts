/**
 * The head-tag data model and its serializer — shared by the client hook
 * (`useMetaTags`, which mutates <head> imperatively for the in-tab experience)
 * and by the build-time prerender (`scripts/prerender.mjs`, which needs the
 * same tags as literal HTML so a crawler that never runs JavaScript sees them).
 *
 * One module owns the defaults so the two paths can't disagree about what
 * "Family Greenhouse's Open Graph card" is. `index.html` carries a literal copy
 * of the defaults between its `head:start`/`head:end` markers purely so
 * `npm run dev` has a sensible head without a build step — the prerender
 * REPLACES that block on every page it emits, including the SPA shell, so the
 * literal copy never reaches production.
 *
 * Canonical strategy (previously a comment in index.html): one index.html
 * serves every SPA route, so a hardcoded homepage canonical would wrongly
 * canonicalize /pricing, /care, /blog, … to "/" and drop them from the index.
 * The rules that replace it:
 *   - A PRERENDERED route emits its own absolute canonical — `meta.canonical`
 *     when the route sets one, otherwise the route's own URL (the safe
 *     default the old comment described).
 *   - The SPA shell, which still answers for every non-prerendered path, emits
 *     NO canonical at all. A missing canonical is a signal Google fills in from
 *     the request URL; an empty or wrong one is a signal that actively removes
 *     the page. `check-prerender-coverage.mjs` enforces exactly this: every
 *     canonical shipped is absolute and non-empty, or absent.
 */

import { SITE_URL, siteUrl } from './site';

/** Open Graph object type. Marketing pages default to `website`; posts and
 *  care guides use `article`. */
export type OgType = 'website' | 'article';

/** Search-engine indexing policy. Use `noindex, nofollow` for app-only,
 * tokenized, or error pages that can otherwise look like valid SPA URLs. */
export type RobotsPolicy = 'index, follow' | 'noindex, follow' | 'noindex, nofollow';

export interface MetaTags {
  title?: string;
  description?: string;
  /** Absolute URL of a per-route OG image, if one is shipped. */
  ogImage?: string;
  ogType?: OgType;
  /** Absolute canonical URL for this route. Sets <link rel="canonical"> + og:url
   *  so Google (which renders the SPA) attributes the page to the right URL
   *  instead of guessing — important for the indexable marketing routes. */
  canonical?: string;
  robots?: RobotsPolicy;
  /** Optional JSON-LD payload (Article, FAQ, etc.). The shape isn't validated
   *  here — the caller is responsible for emitting valid schema.org. */
  jsonLd?: Record<string, unknown>;
}

export const SITE_NAME = 'Family Greenhouse';

/** Purpose-built social cards from the brand renderer. Absolute URLs: social
 *  scrapers (Facebook/LinkedIn/Slack) reject a relative og:image. */
export const DEFAULT_OG_IMAGE = siteUrl('/brand/og-image.png');
export const DEFAULT_TWITTER_IMAGE = siteUrl('/brand/twitter-card.png');
export const OG_IMAGE_ALT =
  'Family Greenhouse — a shared plant-care journal for the whole household';
export const TWITTER_IMAGE_ALT = 'Family Greenhouse — every plant, every person, one care log';

/** Homepage/shell defaults. Every prerendered route overrides what it sets. */
export const DEFAULT_META = {
  title: 'Family Greenhouse — Grow together',
  description:
    'A collaborative plant care app for households. Free accounts include up to 10 plants, shared tasks, reminders, and care history.',
  ogTitle: 'Family Greenhouse — collaborative plant care for households',
  ogDescription:
    'Collaborative plant care for households — share tasks, get reminders, and keep a care log everyone can see. Free for up to 10 plants.',
  twitterDescription:
    'Share tasks, get reminders, and keep a care log everyone can see. Free for up to 10 plants.',
} as const;

/** The fully-resolved head of one page — no optionals left to interpret. */
export interface ResolvedHead {
  title: string;
  description: string;
  /** Absolute URL, or null to emit no canonical/og:url at all (the SPA shell). */
  canonical: string | null;
  ogType: OgType;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  robots: RobotsPolicy;
  jsonLd?: Record<string, unknown> | undefined;
}

/**
 * Resolve a route's `useMetaTags` payload into a complete head.
 *
 * `meta` is null for the SPA shell (no route rendered). `path` is the
 * root-relative URL being rendered, or null when the output has to answer for
 * arbitrary URLs — which is what suppresses the canonical.
 */
export function resolveHead(meta: MetaTags | null, path: string | null): ResolvedHead {
  const title = meta?.title ?? DEFAULT_META.title;
  const description = meta?.description ?? DEFAULT_META.description;

  // A route that sets a title means it for the social card too — that is what
  // useMetaTags does client-side (og:title/twitter:title follow `title`), so
  // the prerender must produce the same tags. Only the shell keeps the
  // distinct marketing-copy defaults.
  const ogTitle = meta?.title ?? DEFAULT_META.ogTitle;
  const ogDescription = meta?.description ?? DEFAULT_META.ogDescription;
  const twitterDescription = meta?.description ?? DEFAULT_META.twitterDescription;

  return {
    title,
    description,
    canonical: meta?.canonical ?? (path === null ? null : siteUrl(path)),
    ogType: meta?.ogType ?? 'website',
    ogTitle,
    ogDescription,
    ogImage: meta?.ogImage ?? DEFAULT_OG_IMAGE,
    twitterTitle: ogTitle,
    twitterDescription,
    twitterImage: meta?.ogImage ?? DEFAULT_TWITTER_IMAGE,
    robots: meta?.robots ?? 'index, follow',
    jsonLd: meta?.jsonLd,
  };
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Serialize JSON-LD for safe inlining: `<` is escaped so a `</script>` inside
 *  the data can't break out of the tag. */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * Serialize a resolved head into the HTML that goes between the
 * `head:start`/`head:end` markers in index.html. Pure — this is the function
 * the prerender calls for every page, including the shell.
 */
export function headToTags(head: ResolvedHead): string {
  const meta = (attr: 'name' | 'property', key: string, value: string) =>
    `<meta ${attr}="${key}" content="${esc(value)}" />`;

  return [
    `<title>${esc(head.title)}</title>`,
    meta('name', 'description', head.description),
    ...(head.canonical ? [`<link rel="canonical" href="${esc(head.canonical)}" />`] : []),
    meta('property', 'og:type', head.ogType),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:title', head.ogTitle),
    meta('property', 'og:description', head.ogDescription),
    ...(head.canonical ? [meta('property', 'og:url', head.canonical)] : []),
    meta('property', 'og:image', head.ogImage),
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    meta('property', 'og:image:alt', OG_IMAGE_ALT),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', head.twitterTitle),
    meta('name', 'twitter:description', head.twitterDescription),
    meta('name', 'twitter:image', head.twitterImage),
    meta('name', 'twitter:image:alt', TWITTER_IMAGE_ALT),
    meta('name', 'robots', head.robots),
    ...(head.jsonLd
      ? [`<script type="application/ld+json">${jsonLdScript(head.jsonLd)}</script>`]
      : []),
  ].join('\n    ');
}

/** Re-exported so callers building absolute URLs don't need a second import. */
export { SITE_URL, siteUrl };
