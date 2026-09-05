#!/usr/bin/env node
/**
 * Regenerate the `PRERENDERED` map inside the CloudFront viewer-request
 * function from `public-routes.mjs`, the same list the sitemap and the
 * prerenderer read.
 *
 * ## Why the edge function has to know the route list at all
 *
 * Until issue #615 it did not. `/dashboard` was rewritten to
 * `/dashboard/index.html`, S3 answered 403 for the missing object, and the
 * distribution's `custom_error_response` turned that into `200 /app-shell.html`.
 * The routing worked — and so did the same rescue for
 * `/assets/index-<hash>.js`, which meant a dropped JS bundle came back as a
 * 200 carrying the shell. `custom_error_response` is a property of the
 * distribution, not of a cache behavior, so it cannot be told to skip
 * `/assets/`. The only way to stop it rescuing asset misses is to stop routes
 * needing it, and that means the function must be able to tell a prerendered
 * page from an app route without asking S3.
 *
 * ## Why generate rather than hand-maintain
 *
 * The list is 50-odd entries and grows with every blog post and care guide,
 * both of which come from TS manifests nobody edits with CloudFront in mind.
 * A hand-copied list would drift silently in the direction that hurts: a new
 * marketing page would be prerendered, uploaded, advertised in the sitemap,
 * and served as the empty shell — which is the exact failure ADR 0013 and
 * `check-prerender-coverage.mjs` exist to prevent, reintroduced one layer
 * lower down.
 *
 * `--check` (npm run spa-router:check, composed by the root `verify`) reads the
 * committed function the way CloudFront does — by evaluating it — and compares
 * the map it actually defines with the route list. It writes nothing: a gate
 * that repairs the artifact it is judging heals drift on the contributor's disk
 * while the committed bytes stay stale. Same reasoning as
 * `build-sitemap.mjs --check`, and the same reason it is a separate gate step.
 *
 * Usage:
 *   node scripts/build-spa-router.mjs           # rewrite the generated block
 *   node scripts/build-spa-router.mjs --check   # verify, write nothing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';

import { FRONTEND_ROOT, publicRoutePaths } from './public-routes.mjs';

export const ROUTER = join(
  FRONTEND_ROOT,
  '..',
  'infrastructure',
  'modules',
  'frontend',
  'functions',
  'spa-router.js'
);

const BEGIN = '// --- generated from public-routes.mjs: do not edit by hand -------------------';
const END = '// --- end generated -----------------------------------------------------------';

/**
 * The routes the function needs a map entry for: every public route except
 * `/`, which the function resolves directly to `/index.html`.
 */
export function mappedRoutes() {
  return publicRoutePaths().filter((route) => route !== '/');
}

/**
 * The map the committed function actually defines, read the way CloudFront
 * reads it — by evaluating the file. Comparing behaviour rather than text is
 * the point: a `PRERENDERED` that parses but is shadowed, misspelled, or
 * commented out would pass a textual diff and fail in production.
 */
export function committedRoutes(source = readFileSync(ROUTER, 'utf8')) {
  const sandbox = {};
  runInNewContext(source, sandbox, { filename: 'spa-router.js' });
  const map = sandbox.PRERENDERED;
  if (map === null || typeof map !== 'object') {
    throw new Error('spa-router.js does not define a PRERENDERED object');
  }
  return Object.keys(map);
}

/** The generated block, formatted the way Prettier formats it. */
function generatedBlock(routes) {
  const entries = routes.map((route) => `  '${route}': 1,`).join('\n');
  return `${BEGIN}\nvar PRERENDERED = {\n${entries}\n};\n${END}`;
}

function replaceBlock(source, routes) {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`spa-router.js is missing its generated block markers (${ROUTER})`);
  }
  return source.slice(0, start) + generatedBlock(routes) + source.slice(end + END.length);
}

function check() {
  const expected = mappedRoutes();
  const actual = committedRoutes();

  const missing = expected.filter((route) => !actual.includes(route));
  const extra = actual.filter((route) => !expected.includes(route));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`spa-router:check OK — ${actual.length} prerendered routes match public-routes.`);
    return;
  }

  console.error(
    '\n❌ spa-router:check: the CloudFront function disagrees with public-routes.mjs.\n' +
      'A route missing here is prerendered, uploaded, and advertised in the sitemap,\n' +
      'and then served as the empty SPA shell — the failure ADR 0013 exists to prevent.\n'
  );
  for (const route of missing) console.error(`  missing from spa-router.js: ${route}`);
  for (const route of extra) console.error(`  in spa-router.js but not public: ${route}`);
  console.error('\nRegenerate with: npm run spa-router --workspace frontend\n');
  process.exitCode = 1;
}

function write() {
  const routes = mappedRoutes();
  const source = readFileSync(ROUTER, 'utf8');
  const next = replaceBlock(source, routes);
  if (next === source) {
    console.log(`spa-router: already up to date (${routes.length} routes).`);
    return;
  }
  writeFileSync(ROUTER, next);
  console.log(`spa-router: wrote ${routes.length} routes into ${ROUTER}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  if (process.argv.includes('--check')) check();
  else write();
}
