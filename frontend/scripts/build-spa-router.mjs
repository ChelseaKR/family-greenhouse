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
/**
 * Why the CloudFront function 301s `www.` to the apex (rule 0 in
 * spa-router.js, which keeps only a pointer because it is under a 10 KB
 * limit and this file is not).
 *
 * `www.<domain>` is a second alias on the same distribution over the same
 * bucket (`include_www_alias`), so both hostnames answered 200 with identical
 * content. Google treated them as two sites. Measured in Search Console on
 * 2026-09-11, over the preceding three months:
 *
 *   - 7 paths were indexed ONLY under `www.` (/care, /care/zz-plant,
 *     /care/monstera, /care/snake-plant, /care/spider-plant, /care/peace-lily,
 *     /care/heartleaf-philodendron)
 *   - 15 paths were indexed ONLY under the apex
 *   - 0 paths on both
 *
 * So one site's ranking signal was split across two hostnames, and the `www.`
 * half sat at average position 55-75 while the apex homepage sat at 6.2.
 *
 * Every page already emits a self-canonical naming the apex, and that was not
 * enough: a canonical is a hint a crawler may ignore, and here it did. A 301
 * is not a hint. It is rule 0 because it has to apply to every path, including
 * the ones later rules rewrite or pass through untouched.
 */
import { join } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';

import { appRoutes } from './app-routes.mjs';
import { FRONTEND_ROOT, PREFIX_SERVED_NAMESPACES, publicRoutePaths } from './public-routes.mjs';

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

/** The prefix a route sits under, or undefined. */
function prefixOf(route, prefixes = PREFIX_SERVED_NAMESPACES) {
  return prefixes.find((prefix) => route.startsWith(prefix));
}

/**
 * The public routes the function serves by PREFIX rather than by map entry
 * (`PREFIX_SERVED_NAMESPACES`, public-routes.mjs).
 *
 * ## Why a prefix rule, and why it stays honest (the per-plant pages)
 *
 * `/pet-safe/<slug>` is one page per plant in the curated pet-toxicity table.
 * Listing each in `PRERENDERED` would cost ~30 bytes a page against the 10 KB
 * CloudFront source limit — the same budget every future blog post and care
 * guide draws on. So the function carries the prefix once (`PREFIXED`) and
 * maps ANY single segment under it onto `<path>/index.html`, lower-cased as
 * React Router matches. It does not need to know which slugs exist: the
 * prerender writes an object only for a published page, the frontend bucket
 * grants `s3:ListBucket`, and a missing object is therefore a 404 — exactly
 * what #719 wants for `/pet-safe/no-such-plant`. The function's size is the
 * same for one plant page or five hundred, and `spa-router.test.mjs` asserts
 * that by generating it both ways.
 *
 * THROWS for a route the edge rule cannot serve: more than one segment below
 * its prefix, an empty segment, a dot (the function leaves dotted paths to
 * S3 as files), or upper case (the rule lower-cases before mapping).
 */
export function prefixServedRoutes(
  paths = publicRoutePaths(),
  prefixes = PREFIX_SERVED_NAMESPACES
) {
  const bad = prefixes.filter((prefix) => !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/$/.test(prefix));
  if (bad.length > 0) {
    throw new Error(`PREFIX_SERVED_NAMESPACES entries must look like "/name/": ${bad.join(', ')}`);
  }
  const served = paths.filter((route) => prefixOf(route, prefixes) !== undefined);
  const unservable = served.filter((route) => {
    const rest = route.slice(prefixOf(route, prefixes).length);
    return rest === '' || /[/.]/.test(rest) || rest !== rest.toLowerCase();
  });
  if (unservable.length > 0) {
    throw new Error(
      `spa-router: ${unservable.join(', ')} cannot be served by the prefix rule — it maps exactly ` +
        'one lower-case, dot-free segment under a PREFIX_SERVED_NAMESPACES prefix.'
    );
  }
  return served;
}

/**
 * The routes the function needs a map entry for: every public route except
 * `/`, which the function resolves directly to `/index.html`, and the routes
 * a prefix rule serves (see `prefixServedRoutes`).
 */
export function mappedRoutes(paths = publicRoutePaths(), prefixes = PREFIX_SERVED_NAMESPACES) {
  prefixServedRoutes(paths, prefixes);
  return paths.filter((route) => route !== '/' && prefixOf(route, prefixes) === undefined);
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

/** The prefixes the committed function actually serves, read by evaluating it. */
export function committedPrefixes(source = readFileSync(ROUTER, 'utf8')) {
  const sandbox = {};
  runInNewContext(source, sandbox, { filename: 'spa-router.js' });
  if (typeof sandbox.PREFIXED !== 'string') {
    throw new Error('spa-router.js does not define a PREFIXED string');
  }
  return sandbox.PREFIXED === '' ? [] : sandbox.PREFIXED.split(' ');
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
export function expectedAppRoutes(paths = publicRoutePaths()) {
  return appRoutes(paths);
}

/** The generated block, formatted the way Prettier formats it. */
function generatedBlock(routes, prefixes) {
  const entries = routes.map((route) => `  '${route}': 1,`).join('\n');
  return `${BEGIN}\nvar PRERENDERED = {\n${entries}\n};\nvar PREFIXED = '${prefixes.join(' ')}';\n${END}`;
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

function replaceBlock(source, routes, app, prefixes = PREFIX_SERVED_NAMESPACES) {
  const withRoutes = spliceBlock(source, BEGIN, END, generatedBlock(routes, prefixes));
  return spliceBlock(withRoutes, APP_BEGIN, APP_END, generatedAppBlock(app));
}

/**
 * Exactly what `write()` would put on disk, without writing it. `paths` is
 * injectable so a test can ask what the function would be with more pages.
 */
export function renderedRouterSource(
  source = readFileSync(ROUTER, 'utf8'),
  paths = publicRoutePaths()
) {
  return replaceBlock(source, mappedRoutes(paths), expectedAppRoutes(paths));
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
      'the CloudFront function disagrees with PREFIX_SERVED_NAMESPACES.',
      PREFIX_SERVED_NAMESPACES,
      committedPrefixes(),
      'A prefix missing here is prerendered and advertised in the sitemap, and then every\n' +
        'page under it answers 404 in production.'
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
    `spa-router:check OK — ${committedRoutes().length} prerendered routes and ` +
      `${committedPrefixes().length} prefix (${prefixServedRoutes().length} pages) match ` +
      `public-routes, and ${actualApp.exact.length} exact + ${actualApp.patterns.length} ` +
      'parameterised app routes match App.tsx.'
  );
}

function write() {
  const routes = mappedRoutes();
  const app = expectedAppRoutes();
  const source = readFileSync(ROUTER, 'utf8');
  const next = replaceBlock(source, routes, app, PREFIX_SERVED_NAMESPACES);
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
