#!/usr/bin/env node
/**
 * Gate the BUILT frontend on the things a crawler that runs no JavaScript can
 * actually see.
 *
 * This exists because the live site failed every one of these at once: all 25
 * sitemap URLs served one shell, so they shared a title and a description, had
 * no <h1>, no canonical and no og:url, and the shell shipped a plaintext-http
 * preconnect and CSP entry naming a developer's loopback address. Every one of
 * those was invisible to lint, typecheck and the test suite, because none of
 * them look at dist/.
 *
 * Deliberately reads only build OUTPUT plus the two published SEO files —
 * never the route manifest the build was generated from. A check that reads
 * the same source as the generator only proves the generator is deterministic;
 * this one has to be able to say the output is wrong.
 *
 * Runs in `npm run verify` (via `npm run seo:check`, which builds first) and in
 * CI's `Build` job against the artifact it is about to upload.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'frontend', 'dist');
/** The apex host every canonical must use. Must match src/config/site.ts. */
const SITE_ORIGIN = 'https://familygreenhouse.net';
/** The SPA fallback shell. Served at many URLs, so it is not a route. */
const FALLBACK = 'app.html';
/** The API origin the app falls back to in development (src/services/api.ts). */
const DEV_API_ORIGIN = 'http://localhost:4000';

const TITLE_MIN = 20;
const TITLE_MAX = 75;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 165;

const errors = [];
const fail = (message) => errors.push(message);

if (!existsSync(DIST)) {
  console.error(
    'check-seo-build: frontend/dist does not exist. Run `npm run build --workspace frontend` first ' +
      '(`npm run seo:check` does it for you).'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Collect the built HTML
// ---------------------------------------------------------------------------

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

/** `dist/index.html` -> `/`, `dist/care/pothos/index.html` -> `/care/pothos`. */
function routeOf(file) {
  const rel = relative(DIST, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'/index.html'.length)}`;
  return null;
}

/** HTML comments ship, but they are not markup. Structural checks ignore them;
 *  the literal scans below deliberately do not. */
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const one = (html, re) => {
  const match = html.match(re);
  return match ? match[1] : null;
};
const metaContent = (html, attr, name) =>
  one(html, new RegExp(`<meta\\s+${attr}="${name}"[^>]*\\scontent="([^"]*)"`)) ??
  one(html, new RegExp(`<meta[^>]*\\scontent="([^"]*)"[^>]*\\s${attr}="${name}"`));

const files = htmlFiles(DIST);
const pages = new Map();
for (const file of files) {
  const rel = relative(DIST, file).split(sep).join('/');
  if (rel === FALLBACK) continue;
  const route = routeOf(file);
  if (route === null) {
    fail(`dist/${rel}: an HTML file that is not <route>/index.html; nothing will ever serve it.`);
    continue;
  }
  pages.set(route, { file, rel, raw: readFileSync(file, 'utf8') });
}

// ---------------------------------------------------------------------------
// 1. The sitemap and the prerendered set must describe the same site
// ---------------------------------------------------------------------------

const sitemapPath = join(DIST, 'sitemap.xml');
if (!existsSync(sitemapPath)) {
  fail('dist/sitemap.xml is missing; robots.txt points search engines at it.');
} else {
  const sitemap = readFileSync(sitemapPath, 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (locs.length === 0) fail('dist/sitemap.xml lists no <loc> entries.');

  const sitemapRoutes = new Set();
  for (const loc of locs) {
    if (!loc.startsWith(`${SITE_ORIGIN}/`)) {
      fail(`dist/sitemap.xml: <loc>${loc}</loc> is not on ${SITE_ORIGIN}.`);
      continue;
    }
    const path = loc.slice(SITE_ORIGIN.length) || '/';
    sitemapRoutes.add(path === '' ? '/' : path);
  }

  for (const route of sitemapRoutes) {
    if (!pages.has(route)) {
      fail(
        `dist/sitemap.xml advertises ${route}, but nothing prerendered it. A crawler asking for ` +
          'that URL gets the fallback shell, with another page’s title.'
      );
    }
  }
  for (const route of pages.keys()) {
    if (!sitemapRoutes.has(route)) {
      fail(`${route} is prerendered but absent from dist/sitemap.xml.`);
    }
  }

  // A <lastmod> in the future is a claim about an edit that has not happened.
  // The generator derives dates from git and from hand-maintained content
  // dates, so a future one means a wrong clock or a typo'd content date.
  const today = new Date().toISOString().slice(0, 10);
  for (const [, lastmod] of sitemap.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(lastmod)) {
      fail(`dist/sitemap.xml: <lastmod>${lastmod}</lastmod> is not a YYYY-MM-DD date.`);
    } else if (lastmod > today) {
      fail(`dist/sitemap.xml: <lastmod>${lastmod}</lastmod> is in the future (today is ${today}).`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Nothing robots.txt disallows may be prerendered
// ---------------------------------------------------------------------------

const robotsPath = join(DIST, 'robots.txt');
if (!existsSync(robotsPath)) {
  fail('dist/robots.txt is missing.');
} else {
  const robots = readFileSync(robotsPath, 'utf8');
  const disallowed = [];
  let wildcard = false;
  for (const line of robots.split('\n')) {
    const text = line.split('#')[0].trim();
    if (text === '') continue;
    const [rawField, ...rest] = text.split(':');
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (field === 'user-agent') wildcard = value === '*';
    else if (field === 'disallow' && wildcard && value !== '') disallowed.push(value);
  }
  if (disallowed.length === 0) fail('dist/robots.txt has no Disallow rules for `User-agent: *`.');
  for (const route of pages.keys()) {
    const hit = disallowed.find((prefix) => route === prefix || route.startsWith(prefix));
    if (hit) {
      fail(
        `${route} is prerendered as an indexable page, but robots.txt disallows "${hit}". ` +
          'A route is either crawlable or it is not.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Per-route head: title, description, canonical, og:url, exactly one h1
// ---------------------------------------------------------------------------

const titles = new Map();
const descriptions = new Map();

for (const [route, page] of pages) {
  const html = stripComments(page.raw);
  const where = `dist/${page.rel} (${route})`;

  const title = one(html, /<title>([\s\S]*?)<\/title>/);
  if (!title || title.trim() === '') {
    fail(`${where}: no <title>.`);
  } else {
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      fail(`${where}: <title> is ${title.length} chars; expected ${TITLE_MIN}-${TITLE_MAX}.`);
    }
    const seen = titles.get(title);
    if (seen) fail(`${where}: <title> is identical to ${seen}'s. Every route needs its own.`);
    else titles.set(title, route);
  }

  const description = metaContent(html, 'name', 'description');
  if (!description || description.trim() === '') {
    fail(`${where}: no meta description.`);
  } else {
    if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
      fail(
        `${where}: meta description is ${description.length} chars; expected ` +
          `${DESCRIPTION_MIN}-${DESCRIPTION_MAX}.`
      );
    }
    const seen = descriptions.get(description);
    if (seen) {
      fail(`${where}: meta description is identical to ${seen}'s. Every route needs its own.`);
    } else {
      descriptions.set(description, route);
    }
  }

  const headings = (html.match(/<h1[\s>]/g) ?? []).length;
  if (headings !== 1) {
    fail(`${where}: ${headings} <h1> elements in the served HTML; expected exactly 1.`);
  }

  const canonical = one(html, /<link\s+rel="canonical"[^>]*\shref="([^"]*)"/);
  const expected = route === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${route}`;
  if (!canonical) {
    fail(`${where}: no <link rel="canonical">.`);
  } else if (canonical !== expected) {
    fail(`${where}: canonical is "${canonical}"; expected the page's own URL, "${expected}".`);
  }

  const ogUrl = metaContent(html, 'property', 'og:url');
  if (!ogUrl) fail(`${where}: no og:url.`);
  else if (canonical && ogUrl !== canonical) {
    fail(`${where}: og:url "${ogUrl}" disagrees with the canonical "${canonical}".`);
  }

  const manifests = (html.match(/<link[^>]*\srel="manifest"/g) ?? []).length;
  if (manifests !== 1) {
    fail(`${where}: ${manifests} manifest links; expected exactly 1 (vite-plugin-pwa owns it).`);
  }

  const robots = metaContent(html, 'name', 'robots');
  if (robots && /noindex/i.test(robots)) {
    fail(`${where}: prerendered as an indexable page but tagged "${robots}".`);
  }
}

// ---------------------------------------------------------------------------
// 4. The fallback shell must not claim to be a page
// ---------------------------------------------------------------------------

const fallbackPath = join(DIST, FALLBACK);
if (!existsSync(fallbackPath)) {
  fail(`dist/${FALLBACK} is missing; CloudFront's SPA fallback has nothing to serve.`);
} else {
  const fallback = stripComments(readFileSync(fallbackPath, 'utf8'));
  if (/<link\s+rel="canonical"/.test(fallback)) {
    fail(
      `dist/${FALLBACK}: the fallback shell carries a canonical. It is served at every route ` +
        'without a page of its own, so that canonical would point all of them at one URL.'
    );
  }
  const robots = metaContent(fallback, 'name', 'robots');
  if (!robots || !/noindex/i.test(robots)) {
    fail(
      `dist/${FALLBACK}: the fallback shell is not marked noindex. The origin answers 200 for ` +
        'every path, so without it any typo or stale link is an indexable soft-404.'
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Literal scans over the raw HTML, comments included: comments ship too
// ---------------------------------------------------------------------------

const LOOPBACK = /localhost|127\.0\.0\.1|\[::1\]/;
for (const file of files) {
  const rel = relative(DIST, file).split(sep).join('/');
  const raw = readFileSync(file, 'utf8');
  if (LOOPBACK.test(raw)) {
    fail(
      `dist/${rel}: names a loopback address. Production HTML must not ship a developer's ` +
        'machine as a resource hint, a CSP source, or anything else.'
    );
  }
  if (raw.includes('__API_')) {
    fail(`dist/${rel}: an unsubstituted API marker survived the build.`);
  }
}

// When the build was given a real API origin, the JS has to have taken it too:
// a bundle that fell back to the dev default would talk to nothing in
// production. Only that exact origin is searched, not "localhost" generally —
// react-router, i18next's language detector and workbox all legitimately carry
// the bare string, so a blanket scan of vendor code could only be silenced by
// allowlisting, which is how a real hit gets waved through.
const apiUrl = process.env.VITE_API_URL ?? '';
if (apiUrl !== '' && !LOOPBACK.test(apiUrl)) {
  const assets = join(DIST, 'assets');
  const bundles = existsSync(assets)
    ? readdirSync(assets)
        .map((f) => join(assets, f))
        .filter((f) => /\.(?:js|css)$/.test(f))
    : [];
  for (const file of bundles) {
    if (readFileSync(file, 'utf8').includes(DEV_API_ORIGIN)) {
      fail(
        `dist/${relative(DIST, file).split(sep).join('/')}: contains the dev API origin even ` +
          `though VITE_API_URL is "${apiUrl}"; the build did not pick the configured origin up.`
      );
    }
  }
}

// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error('SEO build gate failed:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `SEO build gate OK — ${pages.size} prerendered routes, each with its own title, description, ` +
    'self-referencing canonical and single h1; no loopback address in any built HTML.'
);
