/**
 * The single source of truth for the app's PUBLIC, crawlable route list.
 *
 * Two build steps read this list and MUST NOT drift apart:
 *   - `build-sitemap.mjs` → `public/sitemap.xml`  (what we tell Google exists)
 *   - `prerender.mjs`     → `dist/<route>/index.html` (what a crawler can read)
 *
 * Before this module existed the sitemap owned the list alone, and the app
 * shipped no server-rendered HTML at all: every one of the 25 URLs advertised
 * in sitemap.xml resolved to the same empty JavaScript shell. A route that is
 * advertised but not prerendered is an invitation to crawl a blank page; a
 * route prerendered but not advertised is dead weight. `check-prerender-
 * coverage.mjs` fails the build on either, so this stays the only place a
 * public route is declared.
 *
 * Anything behind auth stays OUT of this list. `public/robots.txt` disallows
 * those paths, and the coverage check re-derives that boundary from robots.txt
 * itself — so a protected route added here fails the build instead of leaking a
 * half-rendered dashboard into the search index.
 *
 * Why regexes over the TS manifests instead of a real import: importing a
 * .ts/.tsx module from a vanilla Node script needs a loader (tsx, ts-node,
 * node --experimental-strip-types). The slugs in `posts/index.ts` and
 * `careGuides.ts` are single-quoted string literals on a stable line shape;
 * matching them is simpler and avoids the loader dance. The prerenderer gets
 * the real modules anyway — it imports the compiled SSR bundle — so a slug that
 * parses here but doesn't exist in the app fails at render time, not silently.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to `frontend/`. */
export const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const POSTS = join(FRONTEND_ROOT, 'src', 'features', 'blog', 'posts', 'index.ts');
const CARE = join(FRONTEND_ROOT, 'src', 'features', 'care', 'careGuides.ts');

/**
 * Canonical production origin. MUST match `src/config/site.ts` (SITE_URL) —
 * these are vanilla Node scripts so they can't import the TS const. The prior
 * default (app.familygreenhouse.com) doesn't resolve, so every generated <loc>
 * pointed search engines at a dead domain.
 */
export const SITE = process.env.SITE_URL || 'https://familygreenhouse.net';

/**
 * Public pages that aren't generated from a content manifest. Add to this list
 * when you ship a new public route — the sitemap AND the prerender both pick it
 * up, and the coverage gate proves they did.
 */
export const STATIC_ROUTES = [
  { path: '/', priority: 1.0, changefreq: 'weekly' },
  { path: '/pricing', priority: 0.9, changefreq: 'monthly' },
  { path: '/blog', priority: 0.8, changefreq: 'weekly' },
  { path: '/care', priority: 0.8, changefreq: 'weekly' },
  { path: '/pet-safe', priority: 0.8, changefreq: 'monthly' },
  { path: '/changelog', priority: 0.5, changefreq: 'weekly' },
  { path: '/status', priority: 0.3, changefreq: 'daily' },
  { path: '/legal/privacy', priority: 0.3, changefreq: 'yearly' },
  { path: '/legal/terms', priority: 0.3, changefreq: 'yearly' },
];

/** Blog slugs → ISO publish date, read from the post manifest. */
export function readBlogDates() {
  const src = readFileSync(POSTS, 'utf8');
  const re = /slug:\s*'([^']+)'[\s\S]*?date:\s*'([^']+)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

/** Care-guide slugs → ISO review date, read from the care manifest. */
export function readCareGuides() {
  const src = readFileSync(CARE, 'utf8');
  const re = /slug:\s*'([^']+)'[\s\S]*?reviewed:\s*'([^']+)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

/**
 * Every public route, in sitemap order, as
 * `{ path, priority, changefreq, lastmod }`. `lastmod` falls back to today for
 * a manifest entry with no date rather than being omitted — and such an entry
 * also carries `undated` (the reason), because a `<lastmod>` that changes at
 * midnight makes the committed sitemap unreproducible: `build-sitemap.mjs
 * --check` refuses to verify those routes by name rather than silently skip
 * them.
 */
export function publicRoutes() {
  const today = new Date().toISOString().slice(0, 10);

  const blogEntries = [...readBlogDates().entries()].map(([slug, date]) => ({
    path: `/blog/${slug}`,
    priority: 0.7,
    changefreq: 'monthly',
    lastmod: date ?? today,
    ...(date ? {} : { undated: 'no `date:` in posts/index.ts' }),
  }));

  const careEntries = [...readCareGuides().entries()].map(([slug, reviewed]) => ({
    path: `/care/${slug}`,
    priority: 0.7,
    changefreq: 'monthly',
    lastmod: reviewed ?? today,
    ...(reviewed ? {} : { undated: 'no `reviewed:` in careGuides.ts' }),
  }));

  return [...STATIC_ROUTES, ...blogEntries, ...careEntries];
}

/** Just the paths — what the prerenderer and the coverage gate compare. */
export function publicRoutePaths() {
  return publicRoutes().map((route) => route.path);
}
