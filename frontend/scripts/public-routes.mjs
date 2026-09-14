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

import {
  LASTMOD_LEDGER,
  PLANT_PAGE_PREFIX,
  loadPetToxicityTable,
  pageContentDigest,
  publishedPlantPages,
} from './pet-toxicity-table.mjs';

/** Absolute path to `frontend/`. */
export const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const POSTS = join(FRONTEND_ROOT, 'src', 'features', 'blog', 'posts', 'index.ts');
const CARE = join(FRONTEND_ROOT, 'src', 'features', 'care', 'careGuides.ts');
const HELP = join(FRONTEND_ROOT, 'src', 'features', 'help', 'helpContent.tsx');
const CHANGELOG_PAGE = join(FRONTEND_ROOT, 'src', 'features', 'changelog', 'ChangelogPage.tsx');

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
  // Public gift-subscription landing page: the actual purchase flow
  // (POST /billing/gift/checkout) needs a signed-in buyer, but browsing it —
  // and understanding what it is — needs no account and no household, so it
  // belongs in the crawlable set like /pricing rather than behind auth.
  { path: '/gift', priority: 0.7, changefreq: 'monthly' },
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

/**
 * Namespaces whose pages the CloudFront function serves by PREFIX, not by one
 * `PRERENDERED` entry per page.
 *
 * `spa-router.js` has a hard 10 KB source limit and every `PRERENDERED` entry
 * costs about 30 bytes, so a namespace generated from a data table cannot be
 * enumerated there: the per-plant pages alone would take most of the headroom
 * left for blog posts and care guides. A prefix-served namespace costs a fixed
 * few bytes instead. It stays honest because the function maps any one
 * segment under the prefix onto its `index.html` object, and S3 answers 404
 * when the prerender wrote no such object. `build-spa-router.mjs` keeps these
 * routes out of `PRERENDERED`, and `spa-router.test.mjs` fails if one is added.
 *
 * Every route under a prefix must be exactly one segment below it, since that
 * is all the edge rule maps; `build-spa-router.mjs` refuses anything else.
 */
export const PREFIX_SERVED_NAMESPACES = [PLANT_PAGE_PREFIX];

/** Human-readable name of the plant-page lastmod ledger, for error messages. */
const LEDGER_NAME = 'frontend/scripts/plant-pages-lastmod.json';

/**
 * The committed plant-page `<lastmod>` ledger: `{ pages: { <slug>: { content,
 * lastmod } } }`. Absent is read as empty, which leaves every page unverified
 * rather than silently dated.
 */
export function readPlantPagesLedger(path = LASTMOD_LEDGER) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { pages: {} };
    throw error;
  }
}

/**
 * One public route per published `/pet-safe/<slug>` page, in table order.
 *
 * `lastmod` is the date the ledger pins to that page's CONTENT: the ledger
 * stores a digest of every table field the page shows, next to the date that
 * digest was first seen. When the digest still matches, the date is the
 * page's. When it does not, the route carries `unverifiedLastmod` (the reason)
 * and no date — and `build-sitemap.mjs` refuses to write or pass a sitemap
 * with one, in both modes, rather than falling back to today. The build date
 * never reaches this field; the only way to move it is to change what the page
 * says and run `npm run plant-pages:lastmod --workspace frontend`.
 */
export function plantPageRoutes(table = loadPetToxicityTable(), ledger = readPlantPagesLedger()) {
  return publishedPlantPages(table).map((page) => {
    const route = { path: page.path, priority: 0.7, changefreq: 'monthly' };
    const recorded = ledger?.pages?.[page.slug];
    if (
      !recorded ||
      typeof recorded.lastmod !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(recorded.lastmod)
    ) {
      return { ...route, unverifiedLastmod: `no dated entry in ${LEDGER_NAME}` };
    }
    if (recorded.content !== pageContentDigest(page.entry)) {
      return {
        ...route,
        unverifiedLastmod: `its table entry changed after ${recorded.lastmod}, the date ${LEDGER_NAME} records`,
      };
    }
    return { ...route, lastmod: recorded.lastmod };
  });
}

/** Ledger slugs with no published page — a date kept for a page that is gone. */
export function stalePlantPagesLedgerEntries(
  table = loadPetToxicityTable(),
  ledger = readPlantPagesLedger()
) {
  const published = new Set(publishedPlantPages(table).map((page) => page.slug));
  return Object.keys(ledger?.pages ?? {}).filter((slug) => !published.has(slug));
}

/** Blog slugs → ISO publish date, read from the post manifest. */
export function readBlogDates() {
  const src = readFileSync(POSTS, 'utf8');
  const re = /slug:\s*'([^']+)'[\s\S]*?date:\s*'([^']+)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

/**
 * Care-guide slugs → the ISO date that guide's content last CHANGED, read
 * from the care manifest's `updated` field.
 *
 * Deliberately `updated` and not `reviewed`, which sits one line above it and
 * is what this read before. `reviewed` is the date a human last checked the
 * guide's FACTS; `<lastmod>` is a claim about the file. The two only agree
 * until an edit lands between reviews, and two did (#649 rewrote six
 * `metaTitle`s, #651 added links to twelve guides, both 2026-09-05, neither
 * touching `reviewed`) — so six URLs, zz-plant among them, advertised a
 * `<lastmod>` 80 days older than their own content. Understating `lastmod`
 * is not the safe direction: it is the value a crawler uses to decide a URL
 * whose title just changed does not need refetching.
 */
export function readCareGuides() {
  const src = readFileSync(CARE, 'utf8');
  const re = /slug:\s*'([^']+)'[\s\S]*?updated:\s*'([^']+)'/g;
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
 * The `date:` of every entry rendered by `/changelog`, read from the page's own
 * `ENTRIES` array.
 *
 * This used to read the newest `## [x.y.z] - YYYY-MM-DD` heading in the repo's
 * CHANGELOG.md, and that is a different document. `/changelog` is a
 * hand-curated customer-facing page — an entry every few weeks, in product
 * language — while CHANGELOG.md gains a section on every release, several a
 * week. So the sitemap advertised a freshness the page did not have: measured
 * live on 2026-09-13, `<lastmod>2026-09-12</lastmod>` (0.31.0's release date)
 * against a page whose newest visible entry was 2026-09-02. `lastmod` is the
 * one sitemap field that is a factual claim about the content, and repeated
 * recrawls that find nothing new are how a host's `lastmod` stops being
 * trusted for every URL on it.
 *
 * Matched on the indented `date: 'YYYY-MM-DD',` literals in the ENTRIES array,
 * the same regex-over-the-manifest approach the blog and care lists use and
 * for the same reason (see the module header). The `date: string;` line in the
 * `Entry` interface cannot match: it carries no date literal.
 *
 * THROWS when it finds nothing. The page has twenty entries; zero parsed means
 * the parser broke, not that the page emptied — and the failure mode that
 * matters is the silent one, where `/changelog` quietly loses its `<lastmod>`
 * and no gate notices, because `sitemap:check` only compares the committed
 * bytes against what this code produces. It cannot tell a right date from a
 * wrong one; it can only tell a stale file from a fresh one.
 */
export function readChangelogEntryDates() {
  const src = readFileSync(CHANGELOG_PAGE, 'utf8');
  const re = /^\s+date: '(\d{4}-\d{2}-\d{2})',$/gm;
  const dates = [];
  let m;
  while ((m = re.exec(src)) !== null) dates.push(m[1]);
  if (dates.length === 0) {
    throw new Error(
      `No entry dates found in ${CHANGELOG_PAGE}. /changelog's <lastmod> is derived ` +
        "from the ENTRIES array's `date:` literals; if that shape changed, update this " +
        'parser rather than shipping a sitemap that omits or guesses the date.'
    );
  }
  return dates;
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
 * them. A `/pet-safe/<slug>` route instead carries `unverifiedLastmod` when its
 * content no longer matches the date it was given (see `plantPageRoutes`).
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

  const careEntries = [...readCareGuides().entries()].map(([slug, updated]) => ({
    path: `/care/${slug}`,
    priority: 0.7,
    changefreq: 'monthly',
    lastmod: updated ?? today,
    ...(updated ? {} : { undated: 'no `updated:` in careGuides.ts' }),
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
  // /changelog is the same rule applied to the page's own entries: the newest
  // `date:` in ChangelogPage.tsx is the newest thing a reader can see there.
  // It is NOT the newest CHANGELOG.md release — that is a different document
  // on a different cadence, and deriving from it is what made the sitemap
  // claim ten days of freshness the page did not have (issue #718).
  //
  // The remaining static routes keep no lastmod on purpose, for the reason
  // the help entries above give: there is no honest source for one, and a
  // date that moves at midnight is both a lie and unverifiable.
  const newest = (dates) => [...dates].sort().at(-1);
  const hubLastmod = new Map([
    ['/blog', newest(readBlogDates().values())],
    ['/care', newest(readCareGuides().values())],
    ['/changelog', newest(readChangelogEntryDates())],
  ]);

  const staticEntries = STATIC_ROUTES.map((route) => {
    const lastmod = hubLastmod.get(route.path);
    return lastmod ? { ...route, lastmod } : route;
  });

  return [...staticEntries, ...blogEntries, ...careEntries, ...plantPageRoutes(), ...helpEntries];
}

/** Just the paths — what the prerenderer and the coverage gate compare. */
export function publicRoutePaths() {
  return publicRoutes().map((route) => route.path);
}
