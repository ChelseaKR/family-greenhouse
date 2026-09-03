#!/usr/bin/env node
/**
 * Static prerender via true SSR.
 *
 * Imports the compiled server bundle (`dist-ssr/entry-server.js`), renders each
 * PUBLIC marketing route with react-dom, and inlines the resulting markup and
 * per-route <head> into the client template. No browser and no runtime server:
 * the output is plain files that S3 serves and a crawler can read.
 *
 * Why this exists: every public URL used to answer with the same empty shell —
 * `/`, `/pricing` and `/care` were byte-identical, and the only text a crawler
 * ever received was the shared <title> plus "Family Greenhouse needs JavaScript
 * to run." Meanwhile public/sitemap.xml advertised 25 URLs of real content.
 *
 * What gets rendered comes from `public-routes.mjs`, the same list the sitemap
 * is built from. Nothing behind auth is rendered — see the robots.txt check in
 * `check-prerender-coverage.mjs`, which fails the build if that ever slips.
 *
 * Outputs:
 *   dist/index.html            the prerendered HOMEPAGE (also `/` via S3)
 *   dist/<route>/index.html    one directory per public route
 *   dist/app-shell.html        the pristine SPA shell: CloudFront's error
 *                              response and the service worker's offline
 *                              navigation fallback both point here, so a
 *                              non-prerendered path (the dashboard, an unknown
 *                              URL) still boots the app with an empty #root and
 *                              no hydration mismatch.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FRONTEND_ROOT, publicRoutePaths } from './public-routes.mjs';

const DIST = join(FRONTEND_ROOT, 'dist');
const HEAD_START = '<!--head:start-->';
const HEAD_END = '<!--head:end-->';
const ROOT_DIV = '<div id="root"></div>';

const { renderRoute, shellHead } = await import(
  pathToFileURL(join(FRONTEND_ROOT, 'dist-ssr', 'entry-server.js')).href
);

const template = await readFile(join(DIST, 'index.html'), 'utf8');
if (!template.includes(HEAD_START) || !template.includes(HEAD_END)) {
  throw new Error(
    'dist/index.html has no head:start/head:end markers — run `vite build` first, and check index.html still carries them.'
  );
}
if (!template.includes(ROOT_DIV)) {
  throw new Error('dist/index.html is not a pristine template (no empty <div id="root">).');
}
if (template.includes('__API_ORIGIN__')) {
  throw new Error(
    'dist/index.html still contains __API_ORIGIN__ — the apiOrigin() plugin did not run.'
  );
}

/**
 * Splice a page together from the client template.
 *
 * `head` replaces everything between the markers (markers included, so no
 * build scaffolding ships). `body` goes inside #root; passing '' leaves the
 * root empty, which is how the SPA shell is produced. `path` is stamped on the
 * root element so main.tsx can tell whether the markup it received actually
 * belongs to the URL being loaded before it tries to hydrate it.
 */
function buildPage({ head, body, path }) {
  const headStart = template.indexOf(HEAD_START);
  const headEnd = template.indexOf(HEAD_END) + HEAD_END.length;

  const rootAttr = path === null ? '' : ` data-prerendered="${path}"`;
  const page = template.slice(0, headStart) + head + template.slice(headEnd);
  const withRoot = page.replace(ROOT_DIV, `<div id="root"${rootAttr}>${body}</div>`);

  if (withRoot.includes(HEAD_START) || withRoot.includes(HEAD_END)) {
    throw new Error(`head markers survived into the output for ${path ?? 'app-shell'}`);
  }
  if (withRoot.includes(ROOT_DIV) && body !== '') {
    throw new Error(`#root was not filled for ${path}`);
  }
  return withRoot;
}

/** dist path for a route: '/' → dist/index.html, '/a/b' → dist/a/b/index.html. */
function outputFile(routePath) {
  return routePath === '/'
    ? join(DIST, 'index.html')
    : join(DIST, ...routePath.split('/').filter(Boolean), 'index.html');
}

const routes = publicRoutePaths();
let rendered = 0;

for (const routePath of routes) {
  const { html, head } = await renderRoute(routePath);

  // An empty render means the route resolved to nothing — a typo'd path in the
  // shared route list, or a component that bailed. Shipping the file anyway
  // would recreate the exact bug this script exists to fix, silently.
  if (!html.trim()) throw new Error(`empty render for ${routePath}`);

  const page = buildPage({ head, body: html, path: routePath });
  const file = outputFile(routePath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, page);
  rendered += 1;
}

// The pristine shell. Empty #root and no `data-prerendered`, so main.tsx client
// renders instead of hydrating — identical to the app's behaviour before this
// script existed, which is what every authenticated route still wants.
await writeFile(
  join(DIST, 'app-shell.html'),
  buildPage({ head: shellHead(), body: '', path: null })
);

// Fail the build if the advertised sitemap and the rendered crawl surface drift
// apart, or if anything behind auth got rendered. Runs here so every build that
// prerenders is covered, not just CI.
const { checkPrerenderCoverage } = await import('./check-prerender-coverage.mjs');
checkPrerenderCoverage();

console.log(`prerender: ${rendered} public routes + app-shell.html written to dist/`);
