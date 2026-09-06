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
const HELP = join(FRONTEND_ROOT, 'src', 'features', 'help', 'helpContent.tsx');
const CHANGELOG = join(FRONTEND_ROOT, '..', 'CHANGELOG.md');

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
  { path: '/help', priority: 0.8, changefreq: 'monthly' },
  { path: '/pet-safe', priority: 0.8, changefreq: 'monthly' },
  { path: '/changelog', priority: 0.5, changefreq: 'weekly' },
  { path: '/status', priority: 0.3, changefreq: 'daily' },
  { path: '/legal/privacy', priority: 0.3, changefreq: 'yearly' },
  { path: '/legal/terms', priority: 0.3, changefreq: 'yearly' },
  // Store-listing destinations: /support is the App Store & Play support
  // URL, /account-deletion is Play's mandated deletion web-link. Both are
  // public routes footer-linked from every page, so omitting them here
  // left them unprerendered — served by app-shell.html, which resolves
  // `noindex, follow`, permanently deindexing two branded-navigational
  // landing pages and sinking link equity from all 57 indexable URLs.
  { path: '/support', priority: 0.4, changefreq: 'yearly' },
  { path: '/account-deletion', priority: 0.4, changefreq: 'yearly' },
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
 * Help topic ids, read from `helpContent.tsx` in declaration order.
 *
 * Matched on `id:` immediately followed by `title:`, which is the section
 * shape; an article inside a section is `id:` followed by `q:`, so the two
 * cannot be confused. Reading the manifest rather than restating the nine ids
 * here is what stops `/help/:topicId` from drifting: a section added to the
 * file is advertised and prerendered without anyone remembering to edit this
 * script, and a section removed stops being advertised for the same reason.
 *
 * Every section is public on the web. `webOnly` hides a section inside the
 * iOS/Android shells only, and the store builds are not what a crawler reads.
 */
/**
 * The date of the newest released CHANGELOG entry, for /changelog's lastmod.
 * Matches `## [x.y.z] - YYYY-MM-DD` and ignores `## [Unreleased]`, which
 * carries no date and would otherwise read as the newest thing on the page.
 * Returns undefined if the format ever changes, which omits the tag rather
 * than emitting a wrong one.
 */
export function readChangelogDate() {
  const src = readFileSync(CHANGELOG, 'utf8');
  return /^## \[\d+\.\d+\.\d+\][^\n]*?(\d{4}-\d{2}-\d{2})/m.exec(src)?.[1];
}

export function readHelpTopics() {
  const src = readFileSync(HELP, 'utf8');
  const re = /id:\s*'([^']+)',\s*title:\s*'/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
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

  // No `lastmod`: help answers are edited continuously and carry no review
  // date in the manifest. Falling back to today would make the committed
  // sitemap change at midnight and `--check` unverifiable, so these routes
  // advertise no date at all — which is honest, and reproducible.
  const helpEntries = readHelpTopics().map((topic) => ({
    path: `/help/${topic}`,
    priority: 0.6,
    changefreq: 'monthly',
  }));

  // Hub lastmods, derived rather than restated. `lastmod` is the only
  // sitemap field Google still consumes (changefreq and priority are
  // documented as ignored), and the hubs are where a crawler learns that new
  // children exist — so /blog and /care handing over no freshness signal left
  // recrawl of the two highest-value listing pages to chance.
  //
  // Each is max(children), which is exactly true: the hub changes when its
  // newest child does. Reproducible for the same reason the child entries
  // are, so `--check` still byte-compares.
  //
  // The remaining static routes keep no lastmod on purpose, for the reason
  // the help entries above give: there is no honest source for one, and a
  // date that moves at midnight is both a lie and unverifiable.
  const newest = (dates) => [...dates].sort().at(-1);
  const hubLastmod = new Map([
    ['/blog', newest(readBlogDates().values())],
    ['/care', newest(readCareGuides().values())],
    ['/changelog', readChangelogDate()],
  ]);

  const staticEntries = STATIC_ROUTES.map((route) => {
    const lastmod = hubLastmod.get(route.path);
    return lastmod ? { ...route, lastmod } : route;
  });

  return [...staticEntries, ...blogEntries, ...careEntries, ...helpEntries];
}

/** Just the paths — what the prerenderer and the coverage gate compare. */
export function publicRoutePaths() {
  return publicRoutes().map((route) => route.path);
}
