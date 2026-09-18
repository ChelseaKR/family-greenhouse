#!/usr/bin/env node
/**
 * Tests for `notFoundDocumentFailures` — the build gate on `dist/404.html`,
 * the not-found document CloudFront returns with a 404 for every miss in the
 * frontend bucket (issue #719).
 *
 * The property that matters most is the one a diff cannot show: that document
 * also answers for a missing `/assets/` chunk, so if it ever carries
 * `og:site_name` — the literal `aws_route53_health_check.site` matches — the
 * post-deploy smoke fails and production rolls back. Each case below hands the
 * gate a fixture with exactly one defect and requires it to name that defect,
 * so none of these assertions can pass by never looking.
 *
 * Fixtures, not `dist/`: `npm run test:edge` runs in CI jobs that never build.
 *
 * Run: `npm run test:edge`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { notFoundDocumentFailures } from './check-prerender-coverage.mjs';

const GOOD_HEAD = [
  '<title>Page not found — Family Greenhouse</title>',
  '<meta name="description" content="This page does not exist in Family Greenhouse." />',
  '<meta name="robots" content="noindex, nofollow" />',
].join('\n    ');

const GOOD_ROOT =
  '<div id="root"><div id="main-content"><main><h1>Nothing growing here</h1></main></div></div>';

function page({ head = GOOD_HEAD, root = GOOD_ROOT } = {}) {
  return `<!doctype html><html><head>${head}<script type="module" src="/assets/index-x.js"></script></head><body>${root}\n    <noscript><p>needs JavaScript</p></noscript></body></html>`;
}

/** Run the gate against a dist/ holding `html` as 404.html (or nothing). */
function failuresFor(html) {
  const dist = mkdtempSync(join(tmpdir(), 'edge404-dist-'));
  try {
    if (html !== undefined) writeFileSync(join(dist, '404.html'), html);
    return notFoundDocumentFailures(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test('a correct not-found document passes', () => {
  assert.deepEqual(failuresFor(page()), []);
});

test('a missing 404.html fails, since the error response would have nothing to serve', () => {
  const failures = failuresFor(undefined);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /404\.html is missing/u);
});

test('og:site_name fails the build rather than the release smoke', () => {
  const failures = failuresFor(
    page({
      head: `${GOOD_HEAD}\n    <meta property="og:site_name" content="Family Greenhouse" />`,
    })
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /og:site_name/u);
});

test('a canonical fails, since the document answers for arbitrary URLs', () => {
  const failures = failuresFor(
    page({
      head: `${GOOD_HEAD}\n    <link rel="canonical" href="https://familygreenhouse.net/x" />`,
    })
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /canonical/u);
});

test('a data-prerendered stamp fails, since main.tsx would hydrate it against the wrong URL', () => {
  const failures = failuresFor(
    page({ root: GOOD_ROOT.replace('id="root"', 'id="root" data-prerendered="/x"') })
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /data-prerendered/u);
});

test('an indexable not-found document fails', () => {
  const failures = failuresFor(
    page({ head: GOOD_HEAD.replace('noindex, nofollow', 'index, follow') })
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /noindex/u);
});

test('an empty render fails', () => {
  const failures = failuresFor(page({ root: '<div id="root"></div>' }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no rendered page/u);
});
