#!/usr/bin/env node
/**
 * Unit tests for the pure predicates in `synthetic-page-check.mjs`.
 *
 * Why these exist at all. That script only ever runs against a live origin —
 * the fifteen-minute `uptime.yml` cron and the post-deploy smoke — so nothing
 * in PR CI has ever executed a line of it. Its `--expect-failure` negative
 * control proves the check as a WHOLE can still fail, which is real but coarse:
 * it is satisfied by any one assertion failing, so an assertion that quietly
 * stopped meaning anything would be invisible behind the others.
 *
 * The two predicates added for #615 are exactly the kind that decay that way.
 * `bundleFailures` is the first assertion in this script a served SPA shell
 * cannot satisfy on its own, and `missingAssetFailures` describes a property of
 * the CloudFront distribution that only becomes true after `terraform apply`.
 * Both are asserted here against the responses that were actually measured in
 * production, in both directions: the shape that must pass, and the shape that
 * must fail.
 *
 * Run: `npm run test:checks`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bundleFailures,
  missingAssetFailures,
  moduleScriptSrc,
  pageFailures,
} from './synthetic-page-check.mjs';

const ORIGIN = 'https://familygreenhouse.net';

/** The shape of a healthy page, minimal but complete. */
const goodPage = {
  status: 200,
  contentType: 'text/html',
  finalUrl: `${ORIGIN}/login`,
  origin: ORIGIN,
  body:
    '<!doctype html><html><head><title>Sign in</title>' +
    '<meta property="og:site_name" content="Family Greenhouse" />' +
    '<script type="module" crossorigin src="/assets/index-C4WjWgvt.js"></script>' +
    '</head><body><div id="root"></div></body></html>',
};

test('a healthy page produces no failures', () => {
  assert.deepEqual(pageFailures(goodPage), []);
});

test('the module script src is read out of the page', () => {
  assert.equal(moduleScriptSrc(goodPage.body), '/assets/index-C4WjWgvt.js');
  assert.equal(moduleScriptSrc('<html></html>'), undefined);
});

// --- bundleFailures ---------------------------------------------------------

const servedBundle = {
  src: `${ORIGIN}/assets/index-C4WjWgvt.js`,
  status: 200,
  contentType: 'text/javascript',
  finalUrl: `${ORIGIN}/assets/index-C4WjWgvt.js`,
  origin: ORIGIN,
};

test('a bundle served as JavaScript passes', () => {
  assert.deepEqual(bundleFailures(servedBundle), []);
  // Charset parameters and the other spellings browsers accept.
  assert.deepEqual(
    bundleFailures({ ...servedBundle, contentType: 'text/javascript; charset=UTF-8' }),
    []
  );
  assert.deepEqual(bundleFailures({ ...servedBundle, contentType: 'application/javascript' }), []);
});

// THE assertion #615 turns on. This is what production answered on 2026-09-05
// for a chunk that was not there: 200, text/html, the SPA shell. Every other
// assertion in synthetic-page-check.mjs is satisfied by that response.
test('the SPA shell standing in for a chunk is a failure, not a pass', () => {
  const failures = bundleFailures({ ...servedBundle, contentType: 'text/html' });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not JavaScript/u);
  assert.match(failures[0], /SPA shell standing in for a missing chunk/u);
});

test('a bundle that 404s is a failure', () => {
  const failures = bundleFailures({ ...servedBundle, status: 404 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /HTTP 404/u);
});

test('a bundle that resolves off-origin is a failure', () => {
  const failures = bundleFailures({
    ...servedBundle,
    finalUrl: 'https://cdn.example.invalid/index.js',
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /off-origin/u);
});

// --- missingAssetFailures ---------------------------------------------------

test('a fabricated asset path answering 404 passes', () => {
  assert.deepEqual(missingAssetFailures({ status: 404, body: '<Error>NoSuchKey</Error>' }), []);
});

// Both halves of the #615 report, in one response. The 200 is the lie; the
// search string is why the lie is dangerous.
test('the shell answered for a missing asset fails on both counts', () => {
  const failures = missingAssetFailures({
    status: 200,
    body: goodPage.body,
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /expected 404/u);
  assert.match(failures[1], /health check's search string/u);
});

test('a 404 that still carries the health check string is still a failure', () => {
  const failures = missingAssetFailures({ status: 404, body: goodPage.body });
  assert.equal(failures.length, 1);
  assert.match(failures[1] ?? failures[0], /health check's search string/u);
});
