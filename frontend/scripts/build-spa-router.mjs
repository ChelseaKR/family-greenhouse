#!/usr/bin/env node
/**
 * Regenerate the two lists inside the CloudFront viewer-request function:
 * `PRERENDERED`, from `public-routes.mjs` (the same list the sitemap and the
 * prerenderer read), and `APP_EXACT` / `APP_PATTERNS`, from `App.tsx` via
 * `app-routes.mjs` (the table React Router itself matches).
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
 * The second list exists because the function could not tell `/dashboard` (a
 * real route with no prerendered file) from `/dashboard-typo` (nothing), so it
 * answered 200 with the shell for both — every URL on the host, issue #719.
 * `app-routes.mjs` carries that reasoning in full.
 *
 * `--check` (npm run spa-router:check, composed by the root `verify`) reads the
 * committed function the way CloudFront does — by evaluating it — and compares
 * the lists it actually defines with their sources. It writes nothing: a gate
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

import { appRoutes } from './app-routes.mjs';
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

const APP_BEGIN =
  '// --- generated from App.tsx: do not edit by hand -----------------------------';
const APP_END = '// --- end generated App.tsx ---------------------------------------------------';

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

/**
 * The app-route lists the committed function actually defines, read the same
 * way — by evaluating it. Returned split, as `{ exact, patterns }`.
 */
export function committedAppRoutes(source = readFileSync(ROUTER, 'utf8')) {
  const sandbox = {};
  runInNewContext(source, sandbox, { filename: 'spa-router.js' });
  for (const name of ['APP_EXACT', 'APP_PATTERNS']) {
    if (typeof sandbox[name] !== 'string') {
      throw new Error(`spa-router.js does not define a ${name} string`);
    }
  }
  const split = (value) => (value === '' ? [] : value.split(' '));
  return { exact: split(sandbox.APP_EXACT), patterns: split(sandbox.APP_PATTERNS) };
}

/** What App.tsx says the app routes are, minus what PRERENDERED already covers. */
export function expectedAppRoutes() {
  return appRoutes(publicRoutePaths());
}

/** The generated block, formatted the way Prettier formats it. */
function generatedBlock(routes) {
  const entries = routes.map((route) => `  '${route}': 1,`).join('\n');
  return `${BEGIN}\nvar PRERENDERED = {\n${entries}\n};\n${END}`;
}

/**
 * The App.tsx block. Space-delimited strings, not object literals: spa-router.js
 * has a hard 10 KB ceiling and the two lists cost about half as much this way.
 *
 * The emitted shape has to BE the Prettier-formatted shape, because
 * `format:check` and `spa-router:check` are both steps of the same gate: a
 * generator that emits something Prettier then rewrites makes the two
 * unsatisfiable together. Prettier cannot break a string literal, so it keeps
 * `var NAME = '…';` on one line while that line fits inside printWidth and
 * moves the string to its own indented line when it does not. PRINT_WIDTH below
 * mirrors .prettierrc; `frontend/scripts/spa-router.test.mjs` compares the
 * committed bytes with `renderedRouterSource()` rather than trusting this
 * comment, and the gate's `format:check` step runs Prettier over the file, so
 * the two together pin generator output == committed == formatted.
 */
const PRINT_WIDTH = 100;

function generatedAppBlock({ exact, patterns }) {
  const decl = (name, values) => {
    const oneLine = `var ${name} = '${values.join(' ')}';`;
    return oneLine.length <= PRINT_WIDTH ? oneLine : `var ${name} =\n  '${values.join(' ')}';`;
  };
  return `${APP_BEGIN}\n${decl('APP_EXACT', exact)}\n${decl('APP_PATTERNS', patterns)}\n${APP_END}`;
}

function spliceBlock(source, begin, end, block) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    throw new Error(`spa-router.js is missing its generated block markers (${ROUTER})`);
  }
  return source.slice(0, start) + block + source.slice(stop + end.length);
}

function replaceBlock(source, routes, app) {
  const withRoutes = spliceBlock(source, BEGIN, END, generatedBlock(routes));
  return spliceBlock(withRoutes, APP_BEGIN, APP_END, generatedAppBlock(app));
}

/** Exactly what `write()` would put on disk, without writing it. */
export function renderedRouterSource(source = readFileSync(ROUTER, 'utf8')) {
  return replaceBlock(source, mappedRoutes(), expectedAppRoutes());
}

function reportDrift(label, expected, actual, consequence) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  if (missing.length === 0 && extra.length === 0) return false;

  console.error(`\n❌ spa-router:check: ${label}\n${consequence}\n`);
  for (const value of missing) console.error(`  missing from spa-router.js: ${value}`);
  for (const value of extra) console.error(`  in spa-router.js but not expected: ${value}`);
  return true;
}

function check() {
  const expectedApp = expectedAppRoutes();
  const actualApp = committedAppRoutes();

  const drifted = [
    reportDrift(
      'the CloudFront function disagrees with public-routes.mjs.',
      mappedRoutes(),
      committedRoutes(),
      'A route missing here is prerendered, uploaded, and advertised in the sitemap,\n' +
        'and then served as the empty SPA shell — the failure ADR 0013 exists to prevent.'
    ),
    reportDrift(
      'the CloudFront function disagrees with App.tsx (exact routes).',
      expectedApp.exact,
      actualApp.exact,
      'A route missing here answers 404 in production for a page the app can render,\n' +
        'and a route here that App.tsx no longer has answers 200 for nothing (#719).'
    ),
    reportDrift(
      'the CloudFront function disagrees with App.tsx (parameterised routes).',
      expectedApp.patterns,
      actualApp.patterns,
      'Same consequence as the exact list, for the routes that carry a :param.'
    ),
  ].some(Boolean);

  if (drifted) {
    console.error('\nRegenerate with: npm run spa-router --workspace frontend\n');
    process.exitCode = 1;
    return;
  }

  console.log(
    `spa-router:check OK — ${committedRoutes().length} prerendered routes match ` +
      `public-routes, and ${actualApp.exact.length} exact + ${actualApp.patterns.length} ` +
      'parameterised app routes match App.tsx.'
  );
}

function write() {
  const routes = mappedRoutes();
  const app = expectedAppRoutes();
  const source = readFileSync(ROUTER, 'utf8');
  const next = replaceBlock(source, routes, app);
  const counts = `${routes.length} prerendered + ${app.exact.length}/${app.patterns.length} app`;
  if (next === source) {
    console.log(`spa-router: already up to date (${counts} routes).`);
    return;
  }
  writeFileSync(ROUTER, next);
  console.log(`spa-router: wrote ${counts} routes into ${ROUTER}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  if (process.argv.includes('--check')) check();
  else write();
}
