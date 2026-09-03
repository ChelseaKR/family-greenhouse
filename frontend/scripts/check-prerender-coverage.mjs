#!/usr/bin/env node
/**
 * Build gate: the URLs we ADVERTISE and the URLs we actually RENDER must be the
 * same set, nothing behind auth may be rendered, and every page that ships must
 * carry real, non-empty SEO metadata.
 *
 * This is the check that keeps the fix from quietly rotting. `public-routes.mjs`
 * is a shared source, so the two lists start equal — but a route can still fail
 * to render, a stale directory can survive in dist/, someone can add a URL to
 * sitemap.xml by hand, or a page can render markup with an empty <title>. Each
 * of those looks fine in a diff and is invisible until organic traffic doesn't
 * arrive. So the gate compares what is on disk, not what the source says.
 *
 * Run standalone with `npm run seo:check` (after a build); `prerender.mjs` also
 * calls it directly so every build is covered, not only CI.
 *
 * Failure output names the exact route and the exact reason — see the assert
 * messages below.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { FRONTEND_ROOT, SITE } from './public-routes.mjs';

const DIST = join(FRONTEND_ROOT, 'dist');
const SITEMAP = join(FRONTEND_ROOT, 'public', 'sitemap.xml');
const ROBOTS = join(FRONTEND_ROOT, 'public', 'robots.txt');

/** Every <loc> in the generated sitemap, as root-relative paths. */
function sitemapPaths() {
  const xml = readFileSync(SITEMAP, 'utf8');
  const paths = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const loc = m[1];
    if (!loc.startsWith(SITE)) {
      throw new Error(`sitemap.xml lists ${loc}, which is not on ${SITE}`);
    }
    paths.push(loc.slice(SITE.length) || '/');
  }
  return paths;
}

/** Every prerendered page in dist/, as the route path it answers for. */
function prerenderedPaths() {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Hashed build output, never a route.
        if (entry.name === 'assets' || entry.name === 'brand') continue;
        walk(full);
      } else if (entry.name === 'index.html') {
        const rel = relative(DIST, full).split(sep).slice(0, -1).join('/');
        found.push(rel === '' ? '/' : `/${rel}`);
      }
    }
  };

  walk(DIST);
  return found;
}

/** `Disallow:` prefixes from robots.txt — the auth boundary, read from source. */
function disallowedPrefixes() {
  return readFileSync(ROBOTS, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith('disallow:'))
    .map((line) => line.slice('disallow:'.length).trim())
    .filter(Boolean);
}

/** Pull one attribute out of a tag matched by `pattern`. */
function attr(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1] : null;
}

function checkPageMetadata(routePath, html, failures) {
  const where = `${routePath}`;

  const title = attr(html, /<title>([^<]*)<\/title>/);
  if (!title || !title.trim()) failures.push(`${where}: empty or missing <title>`);

  const description = attr(html, /<meta name="description" content="([^"]*)"/);
  if (!description || !description.trim()) {
    failures.push(`${where}: empty or missing meta description`);
  }

  // The defect this gate was written for: a <link rel="canonical"> with no href
  // (or an empty one) tells a crawler the page canonicalizes to nothing.
  const canonicalTag = html.match(/<link rel="canonical"([^>]*)>/);
  if (!canonicalTag) {
    failures.push(`${where}: no <link rel="canonical">`);
  } else {
    const href = attr(html, /<link rel="canonical" href="([^"]*)"/);
    if (!href || !href.trim()) failures.push(`${where}: empty <link rel="canonical">`);
    else if (href !== `${SITE}${routePath}`) {
      // A route may legitimately canonicalize elsewhere, but it must be
      // absolute and on our origin — never a relative or cross-origin value.
      if (!href.startsWith(SITE)) failures.push(`${where}: canonical ${href} is off-site`);
    }
  }

  for (const [label, pattern] of [
    ['og:title', /<meta property="og:title" content="([^"]*)"/],
    ['og:description', /<meta property="og:description" content="([^"]*)"/],
    ['og:url', /<meta property="og:url" content="([^"]*)"/],
    ['og:image', /<meta property="og:image" content="([^"]*)"/],
  ]) {
    const value = attr(html, pattern);
    if (!value || !value.trim()) failures.push(`${where}: empty or missing ${label}`);
  }

  // Build scaffolding must never ship.
  if (html.includes('<!--head:start-->') || html.includes('<!--head:end-->')) {
    failures.push(`${where}: head markers leaked into the shipped HTML`);
  }
  if (html.includes('__API_ORIGIN__')) {
    failures.push(`${where}: unsubstituted __API_ORIGIN__ placeholder`);
  }

  // React hoists <link>/<meta> to <head>; if one is still sitting inside #root
  // the client's first render won't match and React discards the whole
  // prerendered tree — the page would look right to a crawler but hydrate as if
  // nothing had been prerendered at all. entry-server.tsx moves them out.
  const rootTag = html.match(/<div id="root"[^>]*>([\s\S]*?)<\/div>\s*<noscript>/);
  if (rootTag && /<(?:link|meta)\b/.test(rootTag[1])) {
    failures.push(
      `${where}: a hoistable <link>/<meta> is inside #root — React will hoist it to <head> on the client and hydration will mismatch`
    );
  }

  // The prerender exists so a crawler sees CONTENT, not a shell. If the only
  // text in #root is the noscript notice, the render silently produced nothing.
  const root = html.match(/<div id="root"[^>]*>([\s\S]*?)<\/div>\s*<noscript>/);
  const bodyText = root
    ? root[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
  if (bodyText.length < 200) {
    failures.push(
      `${where}: only ${bodyText.length} characters of visible text rendered — the page is still effectively a shell`
    );
  }

  // A deployed build resolves VITE_API_URL to the real API; if it still points
  // at localhost, the preconnect and CSP would ship a dead origin. Only gate
  // when the variable is actually set, so plain `npm run build` stays green.
  if (process.env.VITE_API_URL && html.includes('localhost')) {
    failures.push(`${where}: localhost reference in a build that set VITE_API_URL`);
  }
}

export function checkPrerenderCoverage() {
  const failures = [];

  if (!existsSync(DIST)) throw new Error('dist/ does not exist — run `npm run build` first.');
  if (!existsSync(join(DIST, 'app-shell.html'))) {
    failures.push(
      "dist/app-shell.html is missing — CloudFront's error response and the service worker navigation fallback both point at it."
    );
  }

  const advertised = sitemapPaths();
  const rendered = prerenderedPaths();
  const advertisedSet = new Set(advertised);
  const renderedSet = new Set(rendered);

  // Divergence, both directions.
  for (const path of advertised) {
    if (!renderedSet.has(path)) {
      failures.push(
        `${path}: advertised in sitemap.xml but NOT prerendered — a crawler would be sent to an empty shell.`
      );
    }
  }
  for (const path of rendered) {
    if (!advertisedSet.has(path)) {
      failures.push(
        `${path}: prerendered but NOT in sitemap.xml — either add it to STATIC_ROUTES in public-routes.mjs or stop rendering it.`
      );
    }
  }

  // The auth boundary, re-derived from robots.txt rather than restated here.
  const disallowed = disallowedPrefixes();
  for (const path of rendered) {
    const hit = disallowed.find((prefix) => path === prefix || path.startsWith(prefix));
    if (hit) {
      failures.push(
        `${path}: prerendered even though robots.txt disallows "${hit}". Routes behind auth must never be rendered to static HTML.`
      );
    }
  }

  // Per-page metadata + real content.
  for (const path of rendered) {
    const file =
      path === '/'
        ? join(DIST, 'index.html')
        : join(DIST, ...path.split('/').filter(Boolean), 'index.html');
    checkPageMetadata(path, readFileSync(file, 'utf8'), failures);
  }

  // The shell answers for arbitrary URLs, so it must NOT claim a canonical.
  const shell = readFileSync(join(DIST, 'app-shell.html'), 'utf8');
  if (/<link rel="canonical"/.test(shell)) {
    failures.push(
      'app-shell.html carries a <link rel="canonical">. It is served for every non-prerendered path, so a canonical there would point /dashboard, /login and every unknown URL at one page.'
    );
  }
  if (shell.includes('<!--head:start-->')) {
    failures.push('app-shell.html: head markers leaked into the shipped HTML');
  }

  if (failures.length > 0) {
    const message = [
      `Prerender coverage check FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`,
      ...failures.map((f) => `  ✗ ${f}`),
    ].join('\n');
    throw new Error(message);
  }

  console.log(
    `prerender coverage: ${rendered.length} routes match sitemap.xml exactly; metadata and auth boundary OK`
  );
}

// Allow `node scripts/check-prerender-coverage.mjs` as a standalone gate.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    checkPrerenderCoverage();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
