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
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  bundleFailures,
  missingAssetFailures,
  moduleScriptSrc,
  pageFailures,
} from './synthetic-page-check.mjs';

const ORIGIN = 'https://familygreenhouse.net';

/** How many of `pageFailures`' reasons have a case that breaks only that one. */
const ISOLATED_PAGE_FAILURE_CASES = 7;

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

// --- pageFailures: the seven ways a page is not this app --------------------
//
// Until these existed, `pageFailures` had exactly one test: the healthy page
// above, which asserts it returns NOTHING. Replacing its whole body with
// `return []` therefore left `npm run test:checks` fully green — 171 tests,
// 171 passing. Every one of the seven reasons it can give was unexamined, on
// the predicate behind the fifteen-minute uptime probe, which exists because a
// forty-minute total frontend outage went unnoticed (#464).
//
// The live `--expect-failure` control in uptime.yml does not close that gap and
// says so in this file's header: it points at /robots.txt, so ONE failing
// assertion satisfies it, and six could rot behind the one that fires.
//
// So each case below breaks exactly ONE property of the good page and asserts
// the list is exactly one reason long. That is what makes them individual:
// a fixture that tripped two assertions would still pass a "there was a
// failure" test while proving nothing about either.

/** One reason, and it is the expected one. */
function onlyFailure(page, expected) {
  const failures = pageFailures(page);
  assert.equal(
    failures.length,
    1,
    `expected exactly one reason, got ${failures.length}: ${JSON.stringify(failures)}`
  );
  assert.match(failures[0], expected);
  return failures[0];
}

test('a page that did not answer 200 is a failure', () => {
  onlyFailure({ ...goodPage, status: 503 }, /HTTP 503 \(expected 200\)/u);
});

test('a page served as something other than HTML is a failure', () => {
  onlyFailure(
    { ...goodPage, contentType: 'application/json' },
    /Content-Type application\/json \(expected text\/html\)/u
  );
  // A response with no Content-Type at all says so rather than reading as one.
  onlyFailure({ ...goodPage, contentType: undefined }, /<missing>/u);
});

test('a page that redirected off-origin is a failure', () => {
  // A parked domain, an expired certificate redirect, a hijacked CNAME: the
  // bytes can be a perfectly good page of somebody else's site.
  onlyFailure(
    { ...goodPage, finalUrl: 'https://example.invalid/login' },
    /redirected off-origin to https:\/\/example\.invalid/u
  );
});

test('a page with nowhere for the app to mount is a failure', () => {
  onlyFailure(
    { ...goodPage, body: goodPage.body.replace('<div id="root">', '<div id="app">') },
    /nowhere to mount/u
  );
});

test('a page that loads no module bundle is a failure', () => {
  onlyFailure(
    {
      ...goodPage,
      body: goodPage.body.replace(
        '<script type="module" crossorigin src="/assets/index-C4WjWgvt.js"></script>',
        ''
      ),
    },
    /the app bundle is not loaded/u
  );
});

test("a page carrying someone else's og:site_name is a failure", () => {
  // The string this asserts is the same one `aws_route53_health_check.site`
  // matches on, so a page that loses it is also a page the health check stops
  // recognising — which is the outage this predicate exists to see.
  onlyFailure(
    {
      ...goodPage,
      body: goodPage.body.replace('content="Family Greenhouse"', 'content="Example Hosting"'),
    },
    /og:site_name is "Example Hosting"/u
  );
  onlyFailure(
    {
      ...goodPage,
      body: goodPage.body.replace(
        '<meta property="og:site_name" content="Family Greenhouse" />',
        ''
      ),
    },
    /og:site_name is missing/u
  );
});

test('a page with no title is a failure', () => {
  onlyFailure(
    { ...goodPage, body: goodPage.body.replace('<title>Sign in</title>', '<title></title>') },
    /empty or missing <title>/u
  );
});

test('every reason pageFailures can give has a case above', async () => {
  // The guard against this file going quietly out of date: a reason added to
  // the predicate without a case here would be as untested as all seven were.
  // Both numbers are derived — the left from the source, the right from the
  // list of cases — so neither can be updated to match the other by hand
  // without the change being visible.
  const source = await readFile(new URL('./synthetic-page-check.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('export function pageFailures('),
    source.indexOf('export function moduleScriptSrc(')
  );
  const reasons = [...body.matchAll(/failures\.push\(/gu)].length;
  assert.equal(
    reasons,
    ISOLATED_PAGE_FAILURE_CASES,
    `pageFailures can give ${reasons} reasons and this file isolates ${ISOLATED_PAGE_FAILURE_CASES}. ` +
      'Add a case that breaks only the new one, then update the count.'
  );
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
