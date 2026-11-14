#!/usr/bin/env node
/**
 * The CloudFront function stays well under its 10 KB limit, and serving
 * `/blog/`, `/care/` and `/help/` by prefix changed no URL's outcome.
 *
 * Why this file exists: on main at 53e95daa the generated `PRERENDERED` map
 * listed every blog post, care guide and help topic, about 30 bytes each, and
 * spa-router.js was 10,232 of the 10,240 bytes CloudFront accepts. PRs #1102
 * and #1103 (eleven more care guides) would have left it about 90 bytes from
 * the limit, with the next guide batch unable to ship. Those three namespaces
 * are now served by the same prefix rule as `/pet-safe/`, so a new post or
 * guide costs the function nothing.
 *
 * "Changed no outcome" is checked against the function as it was, not against
 * a description of it: `fixtures/spa-router.before-headroom.js.txt` is a byte
 * copy of main's spa-router.js before this change (a `.txt` so no linter,
 * formatter or deploy step mistakes it for a live function). Every public
 * route on main, plus every route #1102, #1103 and feat/blog-answer-first
 * add, is replayed through both functions against a model of the bucket, and
 * the viewer-visible result must match.
 *
 * Run: `npm run test:edge`.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import { ROUTER, renderedRouterSource } from './build-spa-router.mjs';
import { FRONTEND_ROOT, publicRoutePaths } from './public-routes.mjs';

const BEFORE_SOURCE = readFileSync(
  join(FRONTEND_ROOT, 'scripts', 'fixtures', 'spa-router.before-headroom.js.txt'),
  'utf8'
);
const AFTER_SOURCE = readFileSync(ROUTER, 'utf8');

/** CloudFront's hard limit on a function's source. */
const CLOUDFRONT_LIMIT = 10 * 1024;

/**
 * The budget this repo holds itself to: about 1.2 KB under the hard limit, so
 * a new static page or a routing fix never has to start by deleting comments.
 */
const HEADROOM_LIMIT = 9000;

/** Why `bytes` breaks the headroom budget, or null if it does not. */
function headroomProblem(bytes) {
  if (bytes <= HEADROOM_LIMIT) return null;
  return (
    `spa-router.js is ${bytes} bytes, over this repo's ${HEADROOM_LIMIT}-byte budget ` +
    `(CloudFront's hard limit is ${CLOUDFRONT_LIMIT}). If a namespace is being listed ` +
    'page by page in PRERENDERED, serve it by prefix instead (PREFIX_SERVED_NAMESPACES ' +
    'in public-routes.mjs); otherwise move explanation out to build-spa-router.mjs.'
  );
}

/** Routes PR #1102 (feat/care-guides-batch4) adds to the sitemap. */
const PR_1102_ROUTES = [
  '/care/air-plant',
  '/care/rosemary',
  '/care/ponytail-palm',
  '/care/areca-palm',
  '/care/schefflera',
  '/pet-safe/rosemary',
];

/** Routes PR #1103 (feat/care-guides-batch5) adds to the sitemap. */
const PR_1103_ROUTES = [
  '/care/satin-pothos',
  '/care/dragon-tree',
  '/care/arrowhead-plant',
  '/care/weeping-fig',
  '/care/polka-dot-plant',
  '/care/tradescantia',
  '/pet-safe/satin-pothos',
  '/pet-safe/dragon-tree',
  '/pet-safe/arrowhead-plant',
  '/pet-safe/weeping-fig',
  '/pet-safe/polka-dot-plant',
];

/** Routes feat/blog-answer-first (head fdb42fbe, no PR yet) adds to the sitemap. */
const BLOG_ANSWER_FIRST_ROUTES = [
  '/blog/do-yellow-leaves-mean-overwatering',
  '/blog/can-you-overwater-a-plant',
];

/**
 * Routes content/watering-guides-batch2 adds to the sitemap. The fixture is
 * main's function before the prefix rule, which listed every care guide, so
 * the BEFORE side needs these added to its map the way that function would
 * have listed them; the AFTER side serves them by prefix at no cost.
 */
const WATERING_BATCH_2_ROUTES = [
  '/care/jasmine',
  '/care/lucky-bamboo',
  '/care/venus-flytrap',
  '/care/majesty-palm',
  '/care/kentia-palm',
  '/care/paperwhite',
  '/care/birds-nest-fern',
  '/care/purple-shamrock',
  '/pet-safe/lucky-bamboo',
  '/pet-safe/venus-flytrap',
  '/pet-safe/majesty-palm',
  '/pet-safe/kentia-palm',
  '/pet-safe/paperwhite',
  '/pet-safe/purple-shamrock',
];

/** Routes seo/care-guides-batch-5 adds to the sitemap, listed for the same reason. */
const CARE_GUIDES_BATCH_6_ROUTES = [
  '/care/thai-constellation-monstera',
  '/care/rattlesnake-plant',
  '/care/peacock-plant',
  '/care/zebra-calathea',
  '/care/calathea-orbifolia',
];

const PENDING_ROUTES = [
  ...PR_1102_ROUTES,
  ...PR_1103_ROUTES,
  ...BLOG_ANSWER_FIRST_ROUTES,
  ...WATERING_BATCH_2_ROUTES,
  ...CARE_GUIDES_BATCH_6_ROUTES,
];

/** Every page that exists once main, #1102 and #1103 are all deployed. */
const ALL_ROUTES = [...new Set([...publicRoutePaths(), ...PENDING_ROUTES])];

/** The namespaces this change moved from the per-page map to the prefix rule. */
const MOVED_PREFIXES = ['/blog/', '/care/', '/help/'];

/**
 * The bucket as the deploy leaves it: one `index.html` per public route (the
 * prerender writes nothing else, and the HTML sync runs with `--delete`), plus
 * the homepage, the app shell and the 404 body.
 */
const BUCKET = new Set([
  '/index.html',
  '/app-shell.html',
  '/404.html',
  ...ALL_ROUTES.filter((route) => route !== '/').map((route) => `${route}/index.html`),
]);

/** A handler evaluated from `source`, optionally with its globals overridden. */
function handlerFrom(source, mutate = () => {}) {
  const sandbox = {};
  runInNewContext(source, sandbox, { filename: 'spa-router.js' });
  mutate(sandbox);
  return (uri) => sandbox.handler({ request: { uri } }).uri;
}

/**
 * The BEFORE function: main's bytes, with the pending branches' care guides
 * and blog posts added to its map the way their own regenerated spa-router.js
 * adds them.
 * (Their `/pet-safe/` pages needed no entry; that prefix was already served.)
 */
const before = handlerFrom(BEFORE_SOURCE, (sandbox) => {
  for (const route of PENDING_ROUTES) {
    if (!route.startsWith('/pet-safe/')) sandbox.PRERENDERED[route] = 1;
  }
});
const after = handlerFrom(AFTER_SOURCE);

/**
 * What the viewer gets for a rewritten URI. CloudFront serves the object if it
 * exists; the frontend bucket grants `s3:ListBucket`, so a missing key is a
 * 404 and the distribution's 404 rule serves /404.html with that status.
 */
function outcome(uri) {
  if (uri === '/app-shell.html') return 'shell (200)';
  if (BUCKET.has(uri)) return `${uri} (200)`;
  // A page-shaped key the prerender never wrote: S3's 404.
  if (uri.endsWith('/index.html')) return '404';
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  // Robots, sitemap, assets, images: this model does not know which exist,
  // so it reports the key S3 is asked for, which both sides must agree on.
  if (last.includes('.')) return `file ${uri} (as S3 has it)`;
  return '404';
}

/** Upper-cases the first letter of the last segment: `/care/Monstera`. */
function titleCased(route) {
  const cut = route.lastIndexOf('/') + 1;
  return route.slice(0, cut) + route.charAt(cut).toUpperCase() + route.slice(cut + 1);
}

/**
 * Every URL worth asking about: each real route as published, with a trailing
 * slash, upper-cased and title-cased; unpublished, nested, dotted, empty and
 * lookalike paths under every content namespace; a sample of every route
 * App.tsx declares; and the passthrough prefixes.
 */
function corpus() {
  const urls = new Set();
  for (const route of ALL_ROUTES) {
    urls.add(route);
    urls.add(`${route}/`);
    urls.add(route.toUpperCase());
    urls.add(titleCased(route));
    if (route !== '/') {
      urls.add(`${route}/extra`);
      urls.add(`${route}.html`);
    }
  }
  for (const prefix of [...MOVED_PREFIXES, '/pet-safe/']) {
    const hub = prefix.slice(0, -1);
    for (const tail of [
      'not-a-real-slug',
      'not-a-real-slug/',
      'NOT-A-REAL-SLUG',
      'no-such/extra',
      'og-image.png',
      '',
      '/',
      'sample-segment-1',
    ]) {
      urls.add(prefix + tail);
    }
    urls.add(`${hub}-ish/pothos`);
    urls.add(`${hub}ful/pothos`);
    urls.add(hub.toUpperCase());
  }
  for (const route of declaredRoutePaths()) {
    if (route === '*') continue;
    const url = sampleUrlFor(route);
    urls.add(url);
    urls.add(url.toUpperCase());
  }
  for (const url of [
    '/assets/index-DOESNOTEXIST.js',
    '/assets/fonts/inter-latin',
    '/.well-known/apple-app-site-association',
    '/.well-known/assetlinks.json',
    '/robots.txt',
    '/sitemap.xml',
    '/definitely-not-a-page',
    '/pricinng',
    '/a/b/c/d',
    '/dashboard',
    '/DASHBOARD',
    '/sit/tok/brief/extra',
  ]) {
    urls.add(url);
  }
  return [...urls];
}

/**
 * The one class of URL whose outcome moved, on purpose: a published page under
 * a moved namespace, reached with different capitalisation. Before, the
 * function sent it to the app shell, which rendered that page client-side
 * (React Router matches case-insensitively). After, the prefix rule
 * lower-cases it onto the prerendered object for the same page, exactly as
 * `/pet-safe/Pothos` has always been served. Same page, same 200, real HTML
 * instead of the shell.
 */
function isCaseVariantOfMovedPage(url) {
  const path = url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
  const lower = path.toLowerCase();
  return (
    path !== lower &&
    MOVED_PREFIXES.some((prefix) => lower.startsWith(prefix)) &&
    ALL_ROUTES.includes(lower)
  );
}

/** Every URL whose viewer outcome differs between `a` and `b`. */
function differences(a, b, urls = corpus()) {
  return urls
    .map((url) => ({ url, before: outcome(a(url)), after: outcome(b(url)) }))
    .filter((row) => row.before !== row.after);
}

test('the corpus actually covers main, #1102, #1103 and feat/blog-answer-first', () => {
  const urls = corpus();
  for (const route of [...publicRoutePaths(), ...PENDING_ROUTES]) {
    assert.ok(urls.includes(route), `corpus is missing ${route}`);
  }
  // A care guide from main, one from each pending PR, and an unknown slug.
  for (const url of [
    '/care/monstera',
    '/care/air-plant',
    '/care/tradescantia',
    '/blog/can-you-overwater-a-plant',
    '/care/not-a-real-slug',
  ]) {
    assert.ok(urls.includes(url), `corpus is missing ${url}`);
  }
  assert.ok(urls.length > 500, `corpus has only ${urls.length} URLs`);
});

test('every URL reaches the same page or the same 404 as before', () => {
  const changed = differences(before, after).filter((row) => !isCaseVariantOfMovedPage(row.url));
  assert.deepEqual(changed, [], 'these URLs now answer differently than on main');
});

test('a mis-capitalised content URL now gets its prerendered page instead of the shell', () => {
  const moved = differences(before, after).filter((row) => isCaseVariantOfMovedPage(row.url));
  assert.ok(moved.length > 0, 'expected the documented case-variant change to be exercised');
  for (const row of moved) {
    const path = row.url.endsWith('/') ? row.url.slice(0, -1) : row.url;
    assert.equal(row.before, 'shell (200)', row.url);
    assert.equal(row.after, `${path.toLowerCase()}/index.html (200)`, row.url);
  }
});

test('every published and pending page is served, and unknown slugs still 404', () => {
  for (const route of ALL_ROUTES) {
    const expected = route === '/' ? '/index.html (200)' : `${route}/index.html (200)`;
    assert.equal(outcome(after(route)), expected, route);
    assert.equal(outcome(before(route)), expected, `${route} (before)`);
  }
  for (const prefix of MOVED_PREFIXES) {
    for (const url of [`${prefix}not-a-real-slug`, `${prefix}not-a-real-slug/`]) {
      assert.equal(outcome(before(url)), '404', `${url} (before)`);
      assert.equal(outcome(after(url)), '404', url);
    }
  }
});

// Negative controls. Each sabotage is checked to have actually applied (the
// sabotaged handler really answers differently for the named URL) before the
// comparison is required to notice it, so a sabotage that silently no-ops
// cannot read as a pass.
test('negative control: dropping /care/ from the prefix list is caught', () => {
  const broken = handlerFrom(AFTER_SOURCE, (sandbox) => {
    sandbox.PREFIXED = sandbox.PREFIXED.split(' ')
      .filter((prefix) => prefix !== '/care/')
      .join(' ');
  });
  assert.equal(outcome(broken('/care/air-plant')), '404', 'sabotage did not apply');
  const urls = differences(before, broken).map((row) => row.url);
  assert.ok(urls.includes('/care/air-plant'), 'a pending guide 404ing went unnoticed');
  assert.ok(urls.includes('/care/monstera'), 'an existing guide 404ing went unnoticed');
});

test('negative control: unknown care slugs reaching the shell is caught', () => {
  const broken = handlerFrom(AFTER_SOURCE, (sandbox) => {
    sandbox.PREFIXED = sandbox.PREFIXED.split(' ')
      .filter((prefix) => prefix !== '/care/')
      .join(' ');
    sandbox.APP_PATTERNS += ' /care/*';
  });
  assert.equal(outcome(broken('/care/not-a-real-slug')), 'shell (200)', 'sabotage did not apply');
  const urls = differences(before, broken).map((row) => row.url);
  assert.ok(urls.includes('/care/not-a-real-slug'), 'a 200 for an unknown slug went unnoticed');
});

test('spa-router.js is under the 9,000-byte headroom budget', () => {
  const bytes = statSync(ROUTER).size;
  assert.equal(headroomProblem(bytes), null);
  // The hard limit too, independently of the budget above.
  assert.ok(bytes < CLOUDFRONT_LIMIT, `${bytes} bytes is over CloudFront's ${CLOUDFRONT_LIMIT}`);
});

test('negative control: the headroom check fails main as it was, and a fattened function', () => {
  const mainBytes = Buffer.byteLength(BEFORE_SOURCE);
  assert.equal(mainBytes, 10232, 'the fixture is no longer main as it was');
  assert.match(headroomProblem(mainBytes) ?? '', /over this repo's 9000-byte budget/);

  // Today's function plus enough comment to cross the budget by one byte.
  const padding = '/'.repeat(HEADROOM_LIMIT - Buffer.byteLength(AFTER_SOURCE) + 1);
  const padded = Buffer.byteLength(AFTER_SOURCE + padding);
  assert.equal(padded, HEADROOM_LIMIT + 1);
  assert.notEqual(headroomProblem(padded), null, `${padded} bytes passed the budget`);
  assert.equal(headroomProblem(HEADROOM_LIMIT), null, 'exactly at the budget must pass');
});

test('adding 500 posts, guides and help topics costs the function nothing', () => {
  const paths = publicRoutePaths();
  const synthetic = MOVED_PREFIXES.flatMap((prefix) =>
    Array.from({ length: 500 }, (_, i) => `${prefix}synthetic-page-${i}`)
  );
  const asPublished = renderedRouterSource(undefined, paths);
  const withMore = renderedRouterSource(undefined, [...paths, ...synthetic, ...PENDING_ROUTES]);
  assert.equal(
    Buffer.byteLength(withMore),
    Buffer.byteLength(asPublished),
    `adding ${synthetic.length + PENDING_ROUTES.length} content pages grew spa-router.js by ` +
      `${Buffer.byteLength(withMore) - Buffer.byteLength(asPublished)} bytes`
  );
});
