import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

import {
  ENDPOINT,
  MAX_URLS,
  SITE,
  buildPayload,
  extractLocs,
  findKey,
  keyLocation,
  main,
  submissionAccepted,
  urlListFailures,
} from './indexnow-submit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Built, not written out: a 32-hex literal next to the word KEY is exactly what
// gitleaks' generic-api-key rule matches, and this one is a fixture.
const KEY = 'ab'.repeat(16);

function keyDir(files = { [`${KEY}.txt`]: KEY }) {
  const dir = mkdtempSync(join(tmpdir(), 'indexnow-key-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function sitemap(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls
    .map((url) => `  <url>\n    <loc>${url}</loc>\n  </url>`)
    .join('\n')}\n</urlset>\n`;
}

/**
 * A fake `fetch` answering from a table of `url -> response | Error`, recording
 * every call. A response may be a list, consumed one per call.
 */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    let answer = routes[url];
    if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
    if (answer === undefined) throw new Error(`unexpected request to ${url}`);
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status,
      url: answer.url ?? url,
      text: async () => answer.body ?? '',
    };
  };
  return { fetchImpl, calls };
}

const LIVE_KEY = { status: 200, body: KEY };
const LIVE_SITEMAP = { status: 200, body: sitemap([`${SITE}/`, `${SITE}/pricing`]) };

async function run(routes, { argv = [], dir = keyDir() } = {}) {
  const summaryFile = join(mkdtempSync(join(tmpdir(), 'indexnow-summary-')), 'summary.md');
  writeFileSync(summaryFile, '');
  const { fetchImpl, calls } = fakeFetch(routes);
  const code = await main(argv, {
    fetchImpl,
    env: { GITHUB_STEP_SUMMARY: summaryFile },
    publicDir: dir,
    retryDelayMs: 0,
    log: () => {},
  });
  return {
    code,
    calls,
    posted: calls.filter((call) => call.url === ENDPOINT),
    summary: readFileSync(summaryFile, 'utf8'),
  };
}

// --- the key file ------------------------------------------------------------

test('the committed key file is the only one, and contains exactly its own name', () => {
  const { key, file } = findKey();
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(file, `${key}.txt`);
  // findKey already compares the bytes; restated so a relaxed findKey cannot
  // quietly accept a newline that IndexNow's verifier might not.
  assert.equal(readFileSync(join(ROOT, 'frontend/public', file), 'utf8'), key);
});

test('findKey refuses no key file, two key files, and a key file with a trailing newline', () => {
  assert.throws(() => findKey(keyDir({ 'robots.txt': 'User-agent: *' })), /found 0/);
  const other = 'cd'.repeat(16);
  assert.throws(() => findKey(keyDir({ [`${KEY}.txt`]: KEY, [`${other}.txt`]: other })), /found 2/);
  assert.throws(() => findKey(keyDir({ [`${KEY}.txt`]: `${KEY}\n` })), /exactly its own name/);
});

test('the key location is the key file at the site root', () => {
  assert.equal(keyLocation(KEY), `https://familygreenhouse.net/${KEY}.txt`);
});

// --- the URL list ------------------------------------------------------------

test('extractLocs reads every <loc> in order and decodes XML entities', () => {
  const xml = sitemap([`${SITE}/`, `${SITE}/care?a=1&amp;b=2`]);
  assert.deepEqual(extractLocs(xml), [`${SITE}/`, `${SITE}/care?a=1&b=2`]);
  assert.deepEqual(extractLocs('<urlset></urlset>'), []);
});

test('the committed sitemap is a submittable URL list', () => {
  // The deploy reads the LIVE sitemap, which is this file as built. If it ever
  // stops being submittable, this fails in CI rather than on the release path.
  const urls = extractLocs(readFileSync(join(ROOT, 'frontend/public/sitemap.xml'), 'utf8'));
  assert.ok(urls.length > 0, 'the committed sitemap lists no URLs');
  assert.deepEqual(urlListFailures(urls), []);
});

test('an empty, oversized, or off-host URL list cannot be submitted', () => {
  assert.match(urlListFailures([]).join('\n'), /no URLs/);
  assert.match(
    urlListFailures(Array.from({ length: MAX_URLS + 1 }, (_, i) => `${SITE}/p${i}`))[0],
    /at most 10000/
  );
  for (const url of [
    'http://familygreenhouse.net/',
    'https://www.familygreenhouse.net/',
    'https://staging.familygreenhouse.net/',
    'https://example.com/',
    'not a url',
  ]) {
    assert.equal(urlListFailures([url]).length, 1, url);
  }
  assert.deepEqual(urlListFailures([`${SITE}/`, `${SITE}/pricing`]), []);
});

test('the payload is the shape IndexNow documents', () => {
  assert.deepEqual(buildPayload({ key: KEY, urls: [`${SITE}/`] }), {
    host: 'familygreenhouse.net',
    key: KEY,
    keyLocation: `https://familygreenhouse.net/${KEY}.txt`,
    urlList: [`${SITE}/`],
  });
});

test('only 200 and 202 count as accepted', () => {
  assert.equal(submissionAccepted(200), true);
  assert.equal(submissionAccepted(202), true);
  for (const status of [0, 204, 301, 400, 403, 422, 429, 500, 503]) {
    assert.equal(submissionAccepted(status), false, String(status));
  }
});

// --- the run -----------------------------------------------------------------

test('a live key and sitemap are posted once, and the summary records it', async () => {
  const result = await run({
    [keyLocation(KEY)]: LIVE_KEY,
    [`${SITE}/sitemap.xml`]: LIVE_SITEMAP,
    [ENDPOINT]: { status: 200 },
  });
  assert.equal(result.code, 0);
  assert.equal(result.posted.length, 1);
  const [post] = result.posted;
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(
    JSON.parse(post.init.body),
    buildPayload({ key: KEY, urls: [`${SITE}/`, `${SITE}/pricing`] })
  );
  assert.match(result.summary, /\| Outcome \| SUBMITTED \|/);
  assert.match(result.summary, /\| HTTP status \| 200 \|/);
  assert.match(result.summary, /\| URLs \| 2 \|/);
});

test('202 is accepted and reported as pending key validation', async () => {
  const result = await run({
    [keyLocation(KEY)]: LIVE_KEY,
    [`${SITE}/sitemap.xml`]: LIVE_SITEMAP,
    [ENDPOINT]: { status: 202 },
  });
  assert.equal(result.code, 0);
  assert.match(result.summary, /ACCEPTED — key validation pending/);
});

test('nothing is posted while the key file is not live', async () => {
  for (const [label, answer] of [
    ['404', { status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }],
    ['the app shell on a 200', { status: 200, body: '<!doctype html><div id="root"></div>' }],
    ['a redirect', { status: 200, body: KEY, url: `https://www.familygreenhouse.net/${KEY}.txt` }],
    ['a network failure, twice', new Error('fetch failed')],
  ]) {
    const result = await run({
      [keyLocation(KEY)]: answer,
      [`${SITE}/sitemap.xml`]: LIVE_SITEMAP,
      [ENDPOINT]: { status: 200 },
    });
    assert.equal(result.code, 1, label);
    assert.equal(result.posted.length, 0, label);
    assert.match(result.summary, /FAILED — nothing was submitted/, label);
  }
});

test('one network blip on a GET is retried, not reported', async () => {
  const result = await run({
    [keyLocation(KEY)]: [new Error('fetch failed'), LIVE_KEY],
    [`${SITE}/sitemap.xml`]: LIVE_SITEMAP,
    [ENDPOINT]: { status: 200 },
  });
  assert.equal(result.code, 0);
  assert.equal(result.posted.length, 1);
});

test('nothing is posted for a sitemap that is missing, empty, or off-host', async () => {
  for (const [label, answer] of [
    ['404', { status: 404 }],
    ['empty', { status: 200, body: sitemap([]) }],
    ['off-host', { status: 200, body: sitemap(['https://example.com/']) }],
  ]) {
    const result = await run({
      [keyLocation(KEY)]: LIVE_KEY,
      [`${SITE}/sitemap.xml`]: answer,
      [ENDPOINT]: { status: 200 },
    });
    assert.equal(result.code, 1, label);
    assert.equal(result.posted.length, 0, label);
  }
});

test('a refusal fails the run and puts the status and body in the summary', async () => {
  const result = await run({
    [keyLocation(KEY)]: LIVE_KEY,
    [`${SITE}/sitemap.xml`]: LIVE_SITEMAP,
    [ENDPOINT]: { status: 403, body: 'Key not valid' },
  });
  assert.equal(result.code, 1);
  assert.match(result.summary, /\| Outcome \| REFUSED \|/);
  assert.match(result.summary, /HTTP 403: Key not valid/);
});

test('a POST with no response is not reported as nothing submitted', async () => {
  const result = await run({
    [keyLocation(KEY)]: LIVE_KEY,
    [`${SITE}/sitemap.xml`]: LIVE_SITEMAP,
    [ENDPOINT]: new Error('The operation was aborted due to timeout'),
  });
  assert.equal(result.code, 1);
  // Exactly one attempt: a POST is never retried.
  assert.equal(result.posted.length, 1);
  assert.match(result.summary, /whether it landed is unknown/);
  assert.doesNotMatch(result.summary, /nothing was submitted/);
});

test('--dry-run verifies everything, posts nothing, and says so', async () => {
  const result = await run(
    { [keyLocation(KEY)]: LIVE_KEY, [`${SITE}/sitemap.xml`]: LIVE_SITEMAP },
    { argv: ['--dry-run'] }
  );
  assert.equal(result.code, 0);
  assert.equal(result.posted.length, 0);
  assert.match(result.summary, /DRY RUN — key file and sitemap verified, nothing was submitted/);
});

// --- the workflows -----------------------------------------------------------

function workflow(name) {
  return load(readFileSync(join(ROOT, '.github/workflows', name), 'utf8'));
}

function needsOf(job) {
  return [job.needs ?? []].flat();
}

test('cd-production submits only after a passing smoke, and nothing waits on it', () => {
  const { jobs } = workflow('cd-production.yml');
  const job = jobs.indexnow;
  assert.ok(job, 'cd-production.yml has no indexnow job');

  assert.ok(needsOf(job).includes('smoke-tests'));
  assert.match(job.if, /needs\.smoke-tests\.result == 'success'/);
  // always()/failure()/cancelled() would let it run on a failed or rolling-back deploy.
  assert.doesNotMatch(job.if, /always\(\)|failure\(\)|cancelled\(\)/);
  assert.equal(job['timeout-minutes'], 5);
  assert.equal(job['continue-on-error'], true);
  assert.deepEqual(job.permissions, { contents: 'read' });

  const text = JSON.stringify(job);
  assert.doesNotMatch(text, /secrets\.|configure-aws-credentials|id-token/);

  // No job may need this one. `rollback` and `notify` are the two that matter —
  // one decides whether production is reverted, the other reports the verdict —
  // and neither can be made to wait on, or read, a search-engine ping.
  for (const [name, other] of Object.entries(jobs)) {
    assert.ok(!needsOf(other).includes('indexnow'), `${name} needs indexnow`);
  }
  assert.doesNotMatch(String(jobs.rollback.if), /indexnow/);
  assert.doesNotMatch(String(jobs.notify.if), /indexnow/);
});

test('indexnow.yml runs only when dispatched, with a read-only token', () => {
  const doc = workflow('indexnow.yml');
  assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
  assert.deepEqual(doc.permissions, {});
  assert.deepEqual(doc.jobs.submit.permissions, { contents: 'read' });
  assert.equal(doc.jobs.submit['timeout-minutes'], 5);
});

test('both submission jobs pin every action by full commit SHA', () => {
  for (const job of [
    workflow('cd-production.yml').jobs.indexnow,
    workflow('indexnow.yml').jobs.submit,
  ]) {
    for (const step of job.steps.filter((s) => s.uses)) {
      assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
    }
  }
});
