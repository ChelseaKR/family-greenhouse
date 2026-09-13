#!/usr/bin/env node
/**
 * Tests for the CloudFront viewer-request function that maps clean marketing
 * URLs onto the prerendered `index.html` objects in the private S3 origin, and
 * every other route onto `/app-shell.html`.
 *
 * That function is the difference between prerendering working and prerendering
 * being invisible — get it wrong and every route silently falls back to the SPA
 * shell, which is exactly the bug the prerender was written to fix and exactly
 * the kind of bug nobody notices from a diff. It also can't be exercised by the
 * app's own test suite, because it runs at the edge, so it gets its own.
 *
 * Since #615 it carries more weight than that. The function no longer leans on
 * the distribution's `custom_error_response` to turn a missing object into the
 * shell: it names `/app-shell.html` itself. That is what lets a request under
 * `/assets/` reach the viewer as a 404 instead of a 200 carrying the shell —
 * `custom_error_response` is a property of the DISTRIBUTION, not of a cache
 * behavior, so it could never be told to skip that one prefix. A bug here is
 * therefore an outage, not a degradation, which is why the route cases below
 * enumerate every kind of path this distribution serves.
 *
 * Run: `npm run test:edge`.
 *
 * This line used to read "(also part of the frontend test gate)". It was not:
 * `frontend`'s `test` is `vitest run`, and vitest.config.ts includes only
 * `tests|src/**\/*.{test,spec}.{ts,tsx}`, which a `.mjs` file under
 * `frontend/scripts/` matches neither. A repo-wide grep for `test:edge` found
 * exactly two hits — its package.json line and this comment claiming it was
 * covered. It now runs in CI's `Test Frontend` job and as a step in
 * `npm run verify`, and scripts/check-test-scripts-run.mjs fails the build if
 * it ever falls out of both again.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { appRoutes, declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import {
  committedAppRoutes,
  committedRoutes,
  expectedAppRoutes,
  mappedRoutes,
  renderedRouterSource,
} from './build-spa-router.mjs';
import { FRONTEND_ROOT } from './public-routes.mjs';
import { publicRoutePaths } from './public-routes.mjs';

const APP_SOURCE = join(FRONTEND_ROOT, 'src', 'App.tsx');

const SOURCE = join(
  FRONTEND_ROOT,
  '..',
  'infrastructure',
  'modules',
  'frontend',
  'functions',
  'spa-router.js'
);

const sandbox = {};
runInNewContext(readFileSync(SOURCE, 'utf8'), sandbox, { filename: 'spa-router.js' });
const { handler } = sandbox;

const rewrite = (uri) => handler({ request: { uri } }).uri;

test('the bare root resolves to the prerendered homepage', () => {
  assert.equal(rewrite('/'), '/index.html');
});

test('every public route maps onto its prerendered object', () => {
  for (const route of publicRoutePaths()) {
    const expected = route === '/' ? '/index.html' : `${route}/index.html`;
    assert.equal(rewrite(route), expected, `route ${route}`);
  }
});

test('a trailing slash resolves to the same object, not a 403', () => {
  assert.equal(rewrite('/pricing/'), '/pricing/index.html');
  assert.equal(rewrite('/care/monstera/'), '/care/monstera/index.html');
});

test('files with extensions pass through untouched', () => {
  for (const asset of [
    '/assets/index-BaVwIxBJ.js',
    '/assets/index-abc123.css',
    '/brand/icon.svg',
    '/brand/favicon.ico',
    '/sitemap.xml',
    '/robots.txt',
    '/sw.js',
    '/manifest.webmanifest',
    '/app-shell.html',
    '/index.html',
  ]) {
    assert.equal(rewrite(asset), asset, `asset ${asset}`);
  }
});

// #615. This used to assert `/dashboard` -> `/dashboard/index.html`, a key that
// does not exist, and the comment explained that S3's 403 plus
// `custom_error_response` produced the shell. That worked for routes and was
// indistinguishable, at the CDN, from a missing JS chunk. The rewrite is now
// explicit, so the error path is free to mean "not found".
test('app routes with no prerendered page are rewritten to the shell by name', () => {
  assert.equal(rewrite('/dashboard'), '/app-shell.html');
  assert.equal(rewrite('/settings/billing'), '/app-shell.html');
  assert.equal(rewrite('/plants/abc-123'), '/app-shell.html');
  assert.equal(rewrite('/login'), '/app-shell.html');
  assert.equal(rewrite('/register'), '/app-shell.html');
  // And with a trailing slash, which is the same route.
  assert.equal(rewrite('/dashboard/'), '/app-shell.html');
});

// ---------------------------------------------------------------------------
// #719. The three assertions below used to read the other way round, and that
// is the finding rather than a detail: this file asserted
//
//     assert.equal(rewrite('/pricinng'), '/app-shell.html');
//     assert.equal(rewrite('/a/b/c/d'), '/app-shell.html');
//
// under the comment "a typo, a stale inbound link, an unknown deep path: all
// still boot the app". The defect was written down as the intended behaviour,
// so the only gate that could have caught it was pinned to it instead.
// ---------------------------------------------------------------------------

test('a path that is not a route is left alone, so S3 answers 404', () => {
  // Exactly the paths the crawl measured returning 200 on the live host.
  for (const uri of [
    '/definitely-not-a-page',
    '/blog/no-such-post',
    '/care/no-such-plant',
    '/help/no-such-topic',
    '/pricinng',
    '/a/b/c/d',
  ]) {
    assert.equal(rewrite(uri), uri, `not-a-route ${uri}`);
  }
  // A trailing slash is the same non-route. The URI is returned unchanged
  // rather than normalised: either way S3 has no such object.
  assert.equal(rewrite('/care/no-such-plant/'), '/care/no-such-plant/');
});

// The namespaces #719 calls out as where a stale external link lands. Every
// valid member is manifest-driven and prerendered, so "not in PRERENDERED"
// under one of these means "does not exist" — which is why they are excluded
// from APP_PATTERNS even though App.tsx declares them as :param routes.
test('the enumerated content namespaces 404 for a slug that is not published', () => {
  for (const prefix of ['/blog/', '/care/', '/help/']) {
    const real = publicRoutePaths().find((route) => route.startsWith(prefix));
    assert.ok(real, `no published page under ${prefix}`);
    assert.equal(rewrite(real), `${real}/index.html`);
    assert.equal(rewrite(`${prefix}not-a-real-slug`), `${prefix}not-a-real-slug`);
  }
});

// The property that makes this safe to ship: the set of URLs that now 404 is
// exactly the set React Router already resolved to its `*` route. Walk every
// route App.tsx declares and require the function to reach the app for it.
test('every route App.tsx declares still reaches the app', () => {
  const { enumerated } = expectedAppRoutes();
  for (const route of declaredRoutePaths()) {
    if (route === '*') continue;
    const url = sampleUrlFor(route);
    if (route === '/') {
      assert.equal(rewrite(url), '/index.html');
      continue;
    }
    if (enumerated.includes(route)) {
      // Deliberately excluded: a sample slug under these does NOT exist, and
      // the published ones are asserted by the PRERENDERED test above.
      assert.equal(rewrite(url), url, `enumerated namespace ${route}`);
      continue;
    }
    const expected = publicRoutePaths().includes(route) ? `${route}/index.html` : '/app-shell.html';
    assert.equal(rewrite(url), expected, `declared route ${route} (as ${url})`);
  }
});

// React Router's <Route caseSensitive> defaults to false, so `/DASHBOARD`
// renders the dashboard in a browser. The function must not answer 404 for a
// URL the app would have handled.
test('route matching is case-insensitive, as React Router is', () => {
  assert.equal(rewrite('/DASHBOARD'), '/app-shell.html');
  assert.equal(rewrite('/Settings/Billing'), '/app-shell.html');
  assert.equal(rewrite('/Pricing'), '/app-shell.html');
  assert.equal(rewrite('/SIT/abc/brief'), '/app-shell.html');
});

// …which only works because every generated key is already lower-case. If one
// were not, the lower-cased lookup in rule (3) would silently stop finding it.
test('every generated route key is lower-case', () => {
  for (const route of committedRoutes()) {
    assert.equal(route, route.toLowerCase(), `PRERENDERED key ${route}`);
  }
  const { exact, patterns } = committedAppRoutes();
  for (const route of exact.concat(patterns)) {
    assert.equal(route, route.toLowerCase(), `app route ${route}`);
  }
});

// A `:param` matches one non-empty segment, no more and no fewer.
test('a parameterised route matches exactly one segment', () => {
  assert.equal(rewrite('/sit/tok'), '/app-shell.html');
  assert.equal(rewrite('/sit/tok/brief'), '/app-shell.html');
  assert.equal(rewrite('/sit/tok/brief/extra'), '/sit/tok/brief/extra');
  assert.equal(rewrite('/sit'), '/sit');
  assert.equal(rewrite('/join/a/b'), '/join/a/b');
});

test('a dot in a non-final path segment does not suppress the rewrite', () => {
  // A token can contain a dot; the extension test reads the LAST segment only.
  assert.equal(rewrite('/sit/a.b/brief'), '/app-shell.html');
});

// The guard that the whole safety argument rests on: if the parser stops
// seeing a route, that route answers 404 to customers. `[^>]*?` cannot cross
// the `>` inside `element={<X />}`, so a <Route> that spells `element` before
// `path` is invisible to the parser — and was invisible to the FIRST draft of
// the counter too, because that draft reused the parser's own prefix. Counting
// the bare attribute is what makes the comparison able to fail.
test('a route the parser cannot see fails the build instead of shipping', () => {
  const hidden = '<Route element={<X />} path="/hidden-from-the-parser" />';
  assert.throws(
    () => appRoutes(publicRoutePaths(), `${readFileSync(APP_SOURCE, 'utf8')}\n${hidden}`),
    /path=/,
    'appRoutes() accepted a <Route> it had not parsed'
  );
  // The same input under the parser's own prefix pattern counts 0 extra, which
  // is why that pattern could not have caught it.
  const prefixCount = (src) => [...src.matchAll(/<Route\b[^>]*?\bpath=/gs)].length;
  assert.equal(prefixCount(hidden), 0);
  assert.equal([...hidden.matchAll(/\bpath=/g)].length, 1);
});

test('the generated app-route lists match App.tsx', () => {
  const expected = appRoutes(publicRoutePaths());
  const actual = committedAppRoutes();
  assert.deepEqual(actual.exact, expected.exact);
  assert.deepEqual(actual.patterns, expected.patterns);
});

// The generator emits a shape Prettier leaves alone — it has to, because
// `format:check` and `spa-router:check` are steps of the same gate and a
// generator Prettier rewrites makes them unsatisfiable together. This pins
// generator-output == committed-bytes; `format:check` pins committed ==
// formatted; together they close the loop.
test('the committed function is byte-identical to what the generator emits', () => {
  assert.equal(readFileSync(SOURCE, 'utf8'), renderedRouterSource());
});

// The reason this file exists at all, after #615.
test('nothing under /assets/ is ever rewritten, so a missing chunk can 404', () => {
  for (const uri of [
    '/assets/index-DOESNOTEXIST.js',
    '/assets/index-C4WjWgvt.js',
    '/assets/vendor-abc.css',
    '/assets/fonts/inter-latin', // extensionless, and still not a route
    '/assets/',
    '/assets',
  ]) {
    assert.equal(rewrite(uri), uri, `asset path ${uri}`);
  }
});

// A prefix that merely starts with the same letters is NOT the asset prefix.
//
// This asserted `/assetsomething` -> `/app-shell.html` until #719, and that
// discriminator is gone: since a path matching no route is now left alone,
// "wrongly treated as an asset" and "correctly treated as a non-route" produce
// the same unchanged URI. No route in App.tsx begins with `assets`, so there is
// no path left that tells the two apart. What survives is still worth pinning —
// a prefix test that matched too broadly would have to answer the shell here —
// and the narrowness of the prefix itself is asserted where it is observable:
// `/assets/fonts/inter-latin` above is extensionless and must pass through.
test('a path that merely starts with "assets" is not treated as a route', () => {
  assert.notEqual(rewrite('/assetsomething'), '/app-shell.html');
  assert.equal(rewrite('/assetsomething'), '/assetsomething');
});

// The deep-link association files. `apple-app-site-association` is
// extensionless by Apple's spec, so before the `/.well-known/` rule it fell
// through to the shell rewrite: Apple's CDN would have been served 200
// text/html regardless of what the deploy uploaded, and the file would have
// sat in the bucket, correctly typed, and unreachable. Asserted here because
// nothing else in the repo can catch it — the upload steps in
// cd-production.yml and scripts/deploy.sh would all report success.
test('nothing under /.well-known/ is rewritten, so an association file is reachable', () => {
  for (const uri of [
    '/.well-known/assetlinks.json',
    '/.well-known/apple-app-site-association', // extensionless: the whole point
    '/.well-known/',
    '/.well-known',
  ]) {
    assert.equal(rewrite(uri), uri, `well-known path ${uri}`);
  }
});

// Same shape as the `/assetsomething` case, and the same #719 caveat: no route
// begins with `.well-known`, so this can no longer distinguish a too-broad
// prefix test from a correct one. The `/.well-known/` prefix's narrowness is
// asserted where it is observable — the extensionless
// `apple-app-site-association` above must pass through unrewritten.
test('a path whose first segment starts with ".well-known" is not a route', () => {
  assert.notEqual(rewrite('/.well-knownish/page'), '/app-shell.html');
  assert.equal(rewrite('/.well-knownish/page'), '/.well-knownish/page');
});

test('the generated route map matches the public route list', () => {
  assert.deepEqual(committedRoutes().sort(), mappedRoutes().sort());
});

// CloudFront rejects a function whose source exceeds 10 KB, and the generated
// map is the only thing in this file that grows — one line per blog post and
// care guide. Failing here is a gate; failing at `terraform apply` is a release.
test('the function stays inside CloudFront’s 10 KB source limit', () => {
  const bytes = statSync(SOURCE).size;
  const limit = 10 * 1024;
  assert.ok(
    bytes < limit,
    `spa-router.js is ${bytes} bytes; CloudFront's limit is ${limit}, ` +
      `so it is over by ${bytes - limit}. The cheapest recovery is to move ` +
      'explanation out to frontend/scripts/app-routes.mjs or ' +
      'frontend/scripts/build-spa-router.mjs, neither of which has a size limit; ' +
      'after that, a leaner encoding for the PRERENDERED map.'
  );
});
