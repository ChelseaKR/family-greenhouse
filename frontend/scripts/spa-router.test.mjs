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

import { committedRoutes, mappedRoutes } from './build-spa-router.mjs';
import { FRONTEND_ROOT } from './public-routes.mjs';
import { publicRoutePaths } from './public-routes.mjs';

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
test('routes with no prerendered page are rewritten to the shell by name', () => {
  assert.equal(rewrite('/dashboard'), '/app-shell.html');
  assert.equal(rewrite('/settings/billing'), '/app-shell.html');
  assert.equal(rewrite('/plants/abc-123'), '/app-shell.html');
  assert.equal(rewrite('/login'), '/app-shell.html');
  assert.equal(rewrite('/register'), '/app-shell.html');
  // A typo, a stale inbound link, an unknown deep path: all still boot the app,
  // which renders its own not-found route.
  assert.equal(rewrite('/pricinng'), '/app-shell.html');
  assert.equal(rewrite('/a/b/c/d'), '/app-shell.html');
  // And with a trailing slash, which is the same route.
  assert.equal(rewrite('/dashboard/'), '/app-shell.html');
});

test('a dot in a non-final path segment does not suppress the rewrite', () => {
  assert.equal(rewrite('/care/x.y/guide'), '/app-shell.html');
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
test('a route that starts with "assets" is still a route', () => {
  assert.equal(rewrite('/assetsomething'), '/app-shell.html');
});

test('the generated route map matches the public route list', () => {
  assert.deepEqual(committedRoutes().sort(), mappedRoutes().sort());
});

// CloudFront rejects a function whose source exceeds 10 KB, and the generated
// map is the only thing in this file that grows — one line per blog post and
// care guide. Failing here is a gate; failing at `terraform apply` is a release.
test('the function stays inside CloudFront’s 10 KB source limit', () => {
  const bytes = statSync(SOURCE).size;
  assert.ok(
    bytes < 10 * 1024,
    `spa-router.js is ${bytes} bytes; CloudFront's limit is ${10 * 1024}. ` +
      'Trim the comments or move the route map to a leaner encoding.'
  );
});
