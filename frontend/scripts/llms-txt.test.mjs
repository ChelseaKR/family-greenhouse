#!/usr/bin/env node
/**
 * /llms.txt (llmstxt.org): a static file in public/, so it ships in dist/ and
 * CloudFront serves it as a file, never the SPA shell or the 404 page.
 *
 * The prices in it are checked against PLAN_PRICES (planPrices.ts, which its
 * own test holds to the backend catalog), so a price change that forgets this
 * file fails here instead of telling assistants a stale number.
 *
 * Run: `npm run test:edge`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { FRONTEND_ROOT } from './public-routes.mjs';

const REPO = join(FRONTEND_ROOT, '..');
const TEXT = readFileSync(join(FRONTEND_ROOT, 'public', 'llms.txt'), 'utf8');
const DEPLOYS = [
  ['scripts/deploy.sh', 'frontend/dist/llms.txt'],
  ['.github/workflows/cd-production.yml', 'dist/llms.txt'],
  ['.github/workflows/cd-staging.yml', 'dist/llms.txt'],
];

test('llms.txt follows the format: H1, summary, then link sections', () => {
  assert.match(TEXT, /^# Family Greenhouse\n\n> \S/);
  assert.match(TEXT, /\n## Pages\n/);
  for (const path of ['/pricing', '/care', '/pet-safe', '/blog', '/help']) {
    assert.ok(TEXT.includes(`(https://familygreenhouse.net${path})`), path);
  }
});

test('llms.txt has no placeholder and makes no tracking claim', () => {
  for (const bad of [
    'TO' + 'DO',
    'T' + 'BD',
    'lorem',
    'X'.repeat(3),
    '{',
    '}',
    'undefined',
    'null',
  ]) {
    assert.ok(!TEXT.includes(bad), bad);
  }
  assert.doesNotMatch(TEXT, /no tracking/i);
});

test('llms.txt prices match the plan catalog', () => {
  const source = readFileSync(
    join(FRONTEND_ROOT, 'src', 'features', 'pricing', 'planPrices.ts'),
    'utf8'
  );
  for (const name of ['Garden', 'Greenhouse']) {
    const m = source.match(new RegExp(`name: '${name}',\\s*monthly: ([0-9.]+)`));
    assert.ok(m, `${name} monthly price in planPrices.ts`);
    assert.ok(TEXT.includes(`${name} is $${m[1]} a month`), `${name} $${m[1]}`);
  }
  assert.match(source, /name: 'Seedling', monthly: 0,/);
});

test('the CloudFront router passes /llms.txt through as a file', () => {
  const sandbox = {};
  const fn = join(REPO, 'infrastructure', 'modules', 'frontend', 'functions', 'spa-router.js');
  runInNewContext(readFileSync(fn, 'utf8'), sandbox);
  assert.equal(sandbox.handler({ request: { uri: '/llms.txt' } }).uri, '/llms.txt');
});

test('every deploy uploads llms.txt as text/plain, outside the immutable tier', () => {
  for (const [file, src] of DEPLOYS) {
    const body = readFileSync(join(REPO, file), 'utf8');
    assert.match(body, /--exclude "llms\.txt"/, `${file}: excluded from the 1-year sync`);
    const cp = body.slice(body.indexOf(`aws s3 cp ${src}`));
    assert.ok(cp.length < body.length, `${file}: copies ${src}`);
    const cmd = cp.split('\n').slice(0, 3).join('\n');
    assert.match(cmd, /--content-type "text\/plain; charset=utf-8"/, `${file}: text/plain`);
    assert.match(cmd, /--cache-control "max-age=3600,public"/, `${file}: an hour`);
  }
});
