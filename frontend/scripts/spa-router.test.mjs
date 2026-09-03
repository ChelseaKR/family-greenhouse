#!/usr/bin/env node
/**
 * Tests for the CloudFront viewer-request function that maps clean marketing
 * URLs onto the prerendered `index.html` objects in the private S3 origin.
 *
 * That function is the difference between prerendering working and prerendering
 * being invisible — get it wrong and every route silently falls back to the SPA
 * shell, which is exactly the bug the prerender was written to fix and exactly
 * the kind of bug nobody notices from a diff. It also can't be exercised by the
 * app's own test suite, because it runs at the edge, so it gets its own.
 *
 * Run: `npm run test:edge` (also part of the frontend test gate).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

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

test('authenticated routes rewrite to keys that do not exist, so they fall back to the shell', () => {
  // Nothing behind auth is prerendered, so these resolve to missing objects.
  // S3 answers 403 and the distribution serves /app-shell.html — the same empty
  // shell the app booted from before prerendering existed.
  assert.equal(rewrite('/dashboard'), '/dashboard/index.html');
  assert.equal(rewrite('/settings/billing'), '/settings/billing/index.html');
  assert.equal(rewrite('/plants/abc-123'), '/plants/abc-123/index.html');
});

test('a dot in a non-final path segment does not suppress the rewrite', () => {
  assert.equal(rewrite('/care/x.y/guide'), '/care/x.y/guide/index.html');
});
