/**
 * The one list of indexable public routes, assembled for the build scripts.
 *
 * `prerender.mjs` writes one HTML shell per entry and `build-sitemap.mjs`
 * writes one <url> per entry, so the sitemap and the prerendered set cannot
 * drift apart — `scripts/check-seo-build.mjs` re-checks that against the built
 * output, from the other direction.
 *
 * This module imports the app's own TypeScript manifests directly. Node strips
 * the types (unflagged since Node 22.18; `package.json` requires >= 22.22), so
 * there is no second copy of any title, description or heading. The imports
 * MUST keep their `.ts` extensions — Node's ESM resolver adds none — and the
 * modules they reach must stay free of `@/` aliases and of React imports.
 */
import { STATIC_PUBLIC_ROUTES } from '../src/config/publicRoutes.ts';
import { siteUrl } from '../src/config/site.ts';
import { landingJsonLd, blogPostJsonLd, careGuideJsonLd } from '../src/config/structuredData.ts';
import { POST_META, postMetaDescription } from '../src/features/blog/posts/meta.ts';
import { CARE_GUIDES } from '../src/features/care/careGuides.ts';

/**
 * @typedef {object} SeoRoute
 * @property {string} path            root-relative path, as it appears in the sitemap
 * @property {string} canonical       absolute apex-hosted canonical URL
 * @property {string} title
 * @property {string} description
 * @property {string} heading         the route's single <h1>
 * @property {'website'|'article'} ogType
 * @property {'daily'|'weekly'|'monthly'|'yearly'} changefreq
 * @property {number} priority
 * @property {object|null} jsonLd     schema.org graph, or null when the route has none
 * @property {string|null} contentDate  hand-maintained content date (ISO), when there is one
 * @property {string[]} dateSources  repo-relative files UNIQUE to this route, whose last commit
 *                                   dates it. Empty when no file is unique to the route.
 */

/** @returns {SeoRoute[]} every route the site invites search engines to crawl. */
export function seoRoutes() {
  /** @type {SeoRoute[]} */
  const routes = STATIC_PUBLIC_ROUTES.map((route) => ({
    path: route.path,
    canonical: siteUrl(route.path),
    title: route.title,
    description: route.description,
    heading: route.heading,
    ogType: route.ogType,
    changefreq: route.changefreq,
    priority: route.priority,
    jsonLd: route.path === '/' ? landingJsonLd() : null,
    contentDate: null,
    dateSources: route.sources.map((s) => `frontend/${s}`),
  }));

  for (const post of POST_META) {
    routes.push({
      path: `/blog/${post.slug}`,
      canonical: siteUrl(`/blog/${post.slug}`),
      title: `${post.title} — Family Greenhouse`,
      description: postMetaDescription(post),
      heading: post.title,
      ogType: 'article',
      changefreq: 'monthly',
      priority: 0.7,
      jsonLd: blogPostJsonLd(post),
      contentDate: post.date,
      // Only the post's own body: `meta.ts` is shared by all six, so dating a
      // post from it would move every post's lastmod whenever any one of them
      // was edited.
      dateSources: [`frontend/src/features/blog/posts/${post.body}.tsx`],
    });
  }

  for (const guide of CARE_GUIDES) {
    routes.push({
      path: `/care/${guide.slug}`,
      canonical: siteUrl(`/care/${guide.slug}`),
      title: guide.metaTitle,
      description: guide.metaDescription,
      heading: `${guide.commonName} care`,
      ogType: 'article',
      changefreq: 'monthly',
      priority: 0.7,
      jsonLd: careGuideJsonLd(guide),
      // `reviewed` is the guide's real content date and the only per-guide one
      // there is: all ten guides live in careGuides.ts, so that file's history
      // cannot tell them apart. No git date for these.
      contentDate: guide.reviewed,
      dateSources: [],
    });
  }

  return routes;
}
