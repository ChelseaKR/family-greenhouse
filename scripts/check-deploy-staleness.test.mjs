/**
 * The detector that answers "is the live site the site this repository has?".
 *
 * Written from both directions, because what it replaces was a green gate.
 * `uptime.yml` has passed every fifteen minutes for months without ever reading
 * which commit is live. A detector that cannot fire is noise and gets deleted; a
 * detector that reports a number it did not really measure is worse than none,
 * because the number reads as a measurement and nobody re-derives it.
 *
 * So the cases below cover the drift it must report AND every way the comparison
 * can be meaningless — no deployment, none that published, a service worker with no
 * fingerprint, a commit this clone does not contain, a diverged history, a live
 * commit no deployment names. Each of those ends in a refusal. None may end in a
 * comfortable zero.
 *
 * The sharpest cases are `test_the_rollback_signature`. `cd-production.yml` restores
 * the previous frontend snapshot when the post-deploy smoke test fails, and neither
 * its `smoke-tests` job nor its `rollback` job declares an `environment:`, so the
 * three `production` deployment rows still say `success` at the tagged commit. A
 * sentinel built on the deployment record alone would call a rolled-back release
 * live. These tests are what keep the frontend fingerprint authoritative.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  StalenessUnknown,
  commitsSince,
  evaluate,
  liveApiCommit,
  liveFrontendCommit,
  main,
  measure,
  published,
  publishedDeployments,
  report,
  requireComparable,
  shipsToVisitors,
} from './check-deploy-staleness.mjs';

const NOW = new Date('2026-09-13T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE = 'ea48db2b5cfbfdd6fdef92d7c08206c37ecd4c16';
const OTHER = '6464382f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The shape workbox actually emits, taken from the live sw.js on 2026-09-13. */
const serviceWorker = (sha = LIVE) =>
  `self.define;e.precacheAndRoute([{revision:"abc",url:"assets/index.js"},` +
  `{revision:"${sha}",url:"app-shell.html"}],{});`;

// --- the live commit, from the bytes a visitor receives -----------------------

test('the app-shell precache revision is the live frontend commit', () => {
  assert.equal(liveFrontendCommit(serviceWorker()), LIVE);
});

test('the fingerprint is found whichever way workbox orders the keys', () => {
  const reversed = `[{url:"app-shell.html",revision:"${LIVE}"}]`;
  assert.equal(liveFrontendCommit(reversed), LIVE);
});

test('a service worker with no fingerprint is a refusal, not an assumption', () => {
  // If VITE_GIT_SHA stops being passed, or workbox renames the entry, this
  // sentinel is measuring nothing. It has to say so rather than fall back.
  assert.throws(
    () => liveFrontendCommit('self.define;e.precacheAndRoute([{revision:"abc",url:"x.js"}]);'),
    (error) => error instanceof StalenessUnknown && /no app-shell.html revision/.test(error.message)
  );
});

test('a timestamp revision is not a commit and is refused', () => {
  // vite.config.ts falls back to `String(Date.now())` outside CI. A build that
  // reached production without VITE_GIT_SHA carries no commit id at all.
  assert.throws(
    () => liveFrontendCommit('[{revision:"1757764800000",url:"app-shell.html"}]'),
    StalenessUnknown
  );
});

test('the API version comes from GET /health', () => {
  assert.equal(liveApiCommit({ status: 'ok', version: LIVE }), LIVE);
});

test('an unknown API version is a refusal', () => {
  // `process.env.GIT_SHA ?? 'unknown'` — a Lambda deployed without the variable.
  assert.throws(() => liveApiCommit({ status: 'ok', version: 'unknown' }), StalenessUnknown);
  assert.throws(() => liveApiCommit({ status: 'ok' }), StalenessUnknown);
});

// --- what the deployment record is allowed to mean ---------------------------

const deployment = (over = {}) => ({
  id: 6422679341,
  sha: LIVE,
  ref: 'v0.31.0',
  environment: 'production',
  created_at: '2026-09-13T14:34:43Z',
  ...over,
});

test('a deployment that succeeded published', () => {
  assert.equal(published([{ state: 'success' }, { state: 'in_progress' }]), true);
});

test('inactive means published then superseded, not never published', () => {
  // 71 of this repository's 100 production rows are in this state: GitHub
  // auto-inactivates older deployments when a newer one succeeds. Rejecting them
  // would leave every build but the current one undatable, which is exactly what
  // the rollback case needs to date.
  assert.equal(published([{ state: 'inactive' }, { state: 'success' }]), true);
});

test('a deployment whose newest status is a failure never published', () => {
  assert.equal(published([{ state: 'failure' }, { state: 'in_progress' }]), false);
  assert.equal(published([{ state: 'error' }, { state: 'in_progress' }]), false);
});

test('a deployment still in progress has published nothing yet', () => {
  assert.equal(published([{ state: 'in_progress' }, { state: 'queued' }]), false);
  assert.equal(published([]), false);
});

test('published deployments come back newest first', () => {
  const rows = publishedDeployments(
    [deployment({ id: 1, sha: OTHER, created_at: '2026-09-11T02:19:38Z' }), deployment({ id: 2 })],
    { 1: [{ state: 'inactive' }, { state: 'success' }], 2: [{ state: 'success' }] }
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [2, 1]
  );
});

test('no deployment at all is a refusal, not a zero', () => {
  assert.throws(
    () => publishedDeployments([], {}),
    (error) => error instanceof StalenessUnknown && /no production deployment/.test(error.message)
  );
});

test('a deployment that never succeeded is a refusal', () => {
  assert.throws(
    () => publishedDeployments([deployment()], { 6422679341: [{ state: 'failure' }] }),
    (error) => error instanceof StalenessUnknown && /successful publish/.test(error.message)
  );
});

test('a failed newer deployment does not hide the successful older one', () => {
  // A failed republish leaves the previous build serving; that is the live one.
  const rows = publishedDeployments(
    [deployment({ id: 9, created_at: '2026-09-13T15:00:00Z' }), deployment({ id: 1, sha: OTHER })],
    { 9: [{ state: 'failure' }], 1: [{ state: 'success' }] }
  );
  assert.deepEqual(
    rows.map((row) => row.sha),
    [OTHER]
  );
});

// --- which files change what a visitor receives ------------------------------

for (const path of [
  'frontend/src/App.tsx',
  'frontend/public/robots.txt',
  'frontend/index.html',
  'frontend/vite.config.ts',
  'frontend/scripts/prerender.mjs',
  'frontend/scripts/app-routes.mjs',
  'backend/src/handlers/api/handler.ts',
  'infrastructure/modules/frontend/functions/spa-router.js',
  '.github/workflows/cd-production.yml',
]) {
  test(`the published site's sources ship to visitors: ${path}`, () => {
    assert.equal(shipsToVisitors(path), true);
  });
}

for (const path of [
  'docs/deployment.md',
  'README.md',
  'CHANGELOG.md',
  'scripts/check-deploy-staleness.mjs',
  'frontend/tests/e2e/smoke.spec.ts',
  'backend/tests/unit/handlers/health.test.ts',
  'frontend/src/sentry.test.ts',
  'frontend/src/components/__tests__/Card.tsx',
  '.github/workflows/ci.yml',
  'package-lock.json',
  'evals/cases.json',
  'frontend/scripts/check-i18n-catalogs.mjs',
  'frontend/scripts/i18n-hardcoded-baseline.json',
  'frontend/scripts/build-mobile-release.sh',
]) {
  test(`everything else does not: ${path}`, () => {
    assert.equal(shipsToVisitors(path), false);
  });
}

test('a test file inside a shipped tree does not ship', () => {
  // `frontend/src/sentry.test.ts` is real, and it sits inside the one tree that
  // matters most. Prefix matching alone would count it.
  assert.equal(shipsToVisitors('frontend/src/sentry.ts'), true);
  assert.equal(shipsToVisitors('frontend/src/sentry.test.ts'), false);
});

// --- the comparison against main, and every way it can be meaningless --------

/**
 * These fixtures build throwaway repositories and point the checker at them, so they
 * only test anything if `-C <tmpdir>` is really where git operates. It is not, if the
 * caller exported `GIT_DIR`: git reads the environment before `-C`, and every git
 * hook exports both `GIT_DIR` and `GIT_INDEX_FILE`. `.githooks/pre-push` runs `npm
 * run verify`, which runs this file, so under a push these fixtures were silently
 * operating on the real worktree — passing for the wrong reason until the commit
 * step failed outright and gave it away. `GIT_ENV` below is the fix on this side;
 * the checker strips the same variables on its own.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pinned to /dev/null for the same
 * reason, one layer further out: `git init` and `git config` inside a fixture must
 * not be able to reach a real configuration file even if something else goes wrong.
 * They also make these tests independent of whatever identity the machine has.
 */
const GIT_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !GIT_OVERRIDES.includes(name))
  ),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const inFixture = (root, args, extraEnv = {}) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...GIT_ENV, ...extraEnv },
  }).trim();

function clone() {
  const root = mkdtempSync(join(tmpdir(), 'fg-staleness-'));
  inFixture(root, ['init', '-b', 'main']);
  inFixture(root, ['config', 'user.email', 'sentinel@example.test']);
  inFixture(root, ['config', 'user.name', 'sentinel']);
  return root;
}

function commit(root, path, { daysAgo = 0 } = {}) {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), `${path}\n`);
  const when = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
  inFixture(root, ['add', path]);
  inFixture(root, ['commit', '-m', `touch ${path}`], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  return inFixture(root, ['rev-parse', 'HEAD']);
}

test('an inherited GIT_DIR does not redirect the comparison to another repository', () => {
  // The bug the pre-push hook found. Without the scrub this reported the drift of
  // whatever repository the hook was running in, which is the same class of defect
  // as a negative control that silently no-ops: a number that looks like a
  // measurement of the thing you asked about and is a measurement of something else.
  const root = clone();
  const live = commit(root, 'frontend/src/App.tsx', { daysAgo: 5 });
  commit(root, 'frontend/src/Card.tsx', { daysAgo: 1 });
  const head = inFixture(root, ['rev-parse', 'HEAD']);

  const elsewhere = clone();
  commit(elsewhere, 'README.md');
  process.env.GIT_DIR = join(elsewhere, '.git');
  try {
    assert.equal(commitsSince(live, head, root).length, 1);
  } finally {
    delete process.env.GIT_DIR;
  }
});

test('a commit this clone does not have is a refusal', () => {
  // The shallow-checkout case, which is the one that reports zero silently:
  // `git log <absent>..HEAD` lists nothing, so the site reads as current. This is
  // why the workflow checks out with fetch-depth: 0 and why this refuses rather
  // than trusting that it did.
  const root = clone();
  const head = commit(root, 'README.md');
  assert.throws(
    () => requireComparable('a'.repeat(40), head, root),
    (error) => error instanceof StalenessUnknown && /not in this clone/.test(error.message)
  );
});

test('a diverged history is a refusal', () => {
  const root = clone();
  const head = commit(root, 'README.md');
  execFileSync('git', ['-C', root, 'checkout', '-b', 'other'], { stdio: 'ignore' });
  const orphan = commit(root, 'orphan.txt');
  assert.throws(
    () => requireComparable(orphan, head, root),
    (error) => error instanceof StalenessUnknown && /not an ancestor/.test(error.message)
  );
});

test('a malformed live commit is a refusal', () => {
  assert.throws(
    () => requireComparable('nope', 'HEAD', clone()),
    (error) => error instanceof StalenessUnknown && /not a commit id/.test(error.message)
  );
});

test('commits since the deploy carry their paths and their dates', () => {
  const root = clone();
  const live = commit(root, 'README.md', { daysAgo: 40 });
  commit(root, 'docs/deployment.md', { daysAgo: 30 });
  commit(root, 'frontend/src/App.tsx', { daysAgo: 20 });
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const commits = commitsSince(live, head, root);

  assert.equal(commits.length, 2);
  assert.deepEqual(commits.at(-1).paths, ['docs/deployment.md']);
  assert.equal(Math.round((NOW.getTime() - commits.at(-1).committedAt.getTime()) / DAY_MS), 30);
});

// --- the verdict -------------------------------------------------------------

function verdict(over = {}) {
  const base = {
    frontendSha: LIVE,
    apiSha: LIVE,
    deployments: [
      { id: 1, sha: LIVE, ref: 'v0.31.0', createdAt: new Date('2026-09-13T14:34:43Z') },
    ],
    headSha: 'f'.repeat(40),
    commits: [],
    now: NOW,
    maxAgeDays: 14,
  };
  return evaluate({ ...base, ...over });
}

const visitorCommit = (daysAgo) => ({
  sha: 'a'.repeat(40),
  committedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
  paths: ['frontend/src/App.tsx'],
});

const quietCommit = (daysAgo) => ({
  sha: 'b'.repeat(40),
  committedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
  paths: ['docs/deployment.md'],
});

test('nothing since the deploy is up to date', () => {
  const result = verdict();
  assert.equal(result.commits, 0);
  assert.equal(result.visitorCommits, 0);
  assert.equal(result.overdue, false);
  assert.match(report(result), /Up to date/);
});

test('age alone is not overdue', () => {
  // A site nobody republished because nothing it publishes changed is correct, not
  // stale. Deploys here are tag-gated, so reporting on the age of the build would
  // fire on every quiet fortnight and the sentinel would be ignored inside a month.
  const result = verdict({
    deployments: [
      { id: 1, sha: LIVE, ref: 'v0.20.0', createdAt: new Date(NOW.getTime() - 200 * DAY_MS) },
    ],
    commits: [quietCommit(150), quietCommit(3)],
  });
  assert.equal(result.commits, 2);
  assert.equal(result.visitorCommits, 0);
  assert.equal(result.buildAgeDays, 200);
  assert.equal(result.overdue, false);
});

test('the clock runs from when the change landed, not from the last deploy', () => {
  // The distinction this repository needs. A build 200 days old with a
  // visitor-visible commit merged yesterday has kept a visitor waiting one day, not
  // two hundred, and firing on 200 would make the first commit after any quiet
  // stretch an instant alarm.
  const result = verdict({
    deployments: [
      { id: 1, sha: LIVE, ref: 'v0.20.0', createdAt: new Date(NOW.getTime() - 200 * DAY_MS) },
    ],
    commits: [visitorCommit(1)],
  });
  assert.equal(result.buildAgeDays, 200);
  assert.equal(result.waitingDays, 1);
  assert.equal(result.overdue, false);
});

test('a visitor-visible commit past the threshold is overdue', () => {
  const result = verdict({ commits: [visitorCommit(20), quietCommit(2)] });
  assert.equal(result.visitorCommits, 1);
  assert.equal(result.waitingDays, 20);
  assert.equal(result.overdue, true);
  assert.match(report(result), /OVERDUE/);
});

test('the oldest waiting visitor-visible commit sets the clock', () => {
  const result = verdict({ commits: [visitorCommit(2), visitorCommit(30)] });
  assert.equal(result.visitorCommits, 2);
  assert.equal(result.waitingDays, 30);
  assert.equal(result.overdue, true);
});

test('the threshold boundary is exclusive', () => {
  assert.equal(verdict({ commits: [visitorCommit(14)] }).overdue, false);
  assert.equal(verdict({ commits: [visitorCommit(15)] }).overdue, true);
});

// --- the rollback, which the deployment record cannot see --------------------

test('the rollback signature: the record says shipped, the frontend says otherwise', () => {
  // Measured on 2026-09-13: `smoke-tests` and `rollback` declare no
  // `environment:`, so all three production rows still report success at the
  // tagged commit after an auto-rollback has put the previous bytes back. Trusting
  // the record here is exactly the direction of error this file exists to prevent.
  const result = verdict({
    frontendSha: OTHER,
    apiSha: LIVE,
    deployments: [
      { id: 2, sha: LIVE, ref: 'v0.31.0', createdAt: new Date('2026-09-13T14:34:43Z') },
      { id: 1, sha: OTHER, ref: 'v0.30.0', createdAt: new Date('2026-09-11T02:19:38Z') },
    ],
    commits: [visitorCommit(1)],
  });

  assert.equal(result.frontendSha, OTHER, 'the live commit is the bytes, not the record');
  assert.equal(result.deploymentId, 1, 'dated from the deploy that published those bytes');
  assert.equal(result.recordDisagrees, true);
  assert.equal(result.apiDisagrees, true);
  assert.equal(result.overdue, true, 'a rolled-back release is reported even inside the threshold');
  assert.match(report(result), /ROLLED BACK OR HALF-APPLIED/);
  assert.match(report(result), /SPLIT STACK/);
});

test('a half-applied release is reported even when nothing is waiting', () => {
  // v0.22.0, 2026-07-19: `Deploy Frontend` failed, `Deploy Backend` succeeded, and
  // the rollback failed too. The newest published row named a commit the frontend
  // was never serving.
  const result = verdict({
    frontendSha: OTHER,
    apiSha: OTHER,
    deployments: [
      { id: 2, sha: LIVE, ref: 'v0.22.0', createdAt: new Date('2026-07-19T17:50:26Z') },
      { id: 1, sha: OTHER, ref: 'v0.21.0', createdAt: new Date('2026-07-17T05:41:40Z') },
    ],
    commits: [],
  });
  assert.equal(result.recordDisagrees, true);
  assert.equal(result.apiDisagrees, false);
  assert.equal(result.overdue, true);
});

test('bytes from a commit no deployment names is a refusal', () => {
  // Something published outside `cd-production.yml`, or the deployment that did it
  // has aged out of the API window. Either way the live build cannot be dated, and
  // a guess would be the comfortable zero this refuses to give.
  assert.throws(
    () =>
      verdict({
        frontendSha: 'c'.repeat(40),
        deployments: [
          { id: 1, sha: LIVE, ref: 'v0.31.0', createdAt: new Date('2026-09-13T14:34:43Z') },
        ],
      }),
    (error) =>
      error instanceof StalenessUnknown &&
      /no successful production deployment names/.test(error.message)
  );
});

// --- the report and the whole pipeline ---------------------------------------

test('the report states the measurement before its verdict', () => {
  const text = report(verdict({ commits: [visitorCommit(20)] }));
  assert.match(text, new RegExp(LIVE.slice(0, 9)));
  assert.ok(text.indexOf('Behind by') < text.indexOf('OVERDUE'));
  assert.ok(text.indexOf('Live frontend') < text.indexOf('Behind by'));
});

test('measure reads the record, the bytes and the history together', () => {
  const root = clone();
  const live = commit(root, 'frontend/src/App.tsx', { daysAgo: 40 });
  commit(root, 'frontend/src/Card.tsx', { daysAgo: 30 });
  commit(root, 'docs/deployment.md', { daysAgo: 1 });

  const result = measure({
    deployments: [
      { id: 77, sha: live, ref: 'v0.30.0', environment: 'production', created_at: '2026-08-04' },
    ],
    statusesById: { 77: [{ state: 'success' }] },
    serviceWorker: serviceWorker(live),
    health: { status: 'ok', version: live },
    head: 'HEAD',
    now: NOW,
    repoRoot: root,
  });

  assert.equal(result.frontendSha, live);
  assert.equal(result.commits, 2);
  assert.equal(result.visitorCommits, 1);
  assert.equal(result.waitingDays, 30);
  assert.equal(result.recordDisagrees, false);
  assert.equal(result.apiDisagrees, false);
  assert.equal(result.overdue, true);
});

test('measure refuses when the live commit is absent from the clone', () => {
  const root = clone();
  commit(root, 'README.md');
  assert.throws(
    () =>
      measure({
        deployments: [
          { id: 1, sha: LIVE, ref: 'v0.31.0', environment: 'production', created_at: '2026-09-13' },
        ],
        statusesById: { 1: [{ state: 'success' }] },
        serviceWorker: serviceWorker(LIVE),
        health: { status: 'ok', version: LIVE },
        head: 'HEAD',
        now: NOW,
        repoRoot: root,
      }),
    (error) => error instanceof StalenessUnknown && /not in this clone/.test(error.message)
  );
});

// --- the exit code, which is the whole difference between two verdicts -------

/** Run `main` with stderr captured, so a refusal does not litter the test output. */
function cli(argv) {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    return { code: main(argv), stderr: written.join('') };
  } finally {
    process.stderr.write = original;
  }
}

function inputs(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fg-staleness-cli-'));
  const files = {
    deployments: '[]',
    statuses: '{}',
    'sw.js': serviceWorker(),
    'health.json': JSON.stringify({ status: 'ok', version: LIVE }),
    ...over,
  };
  const path = (name) =>
    join(dir, name.endsWith('.js') || name.endsWith('.json') ? name : `${name}.json`);
  for (const [name, body] of Object.entries(files)) writeFileSync(path(name), body);
  return [
    '--deployments',
    path('deployments'),
    '--statuses',
    path('statuses'),
    '--service-worker',
    path('sw.js'),
    '--health',
    path('health.json'),
  ];
}

test('the CLI refuses with a non-zero exit when it cannot measure', () => {
  // Exit 2, not 0 with a reassuring report. The sentinel workflow turns a
  // measurement into an issue and a refusal into a red run, so this exit code is
  // the whole difference between "the site is fine" and "nobody can tell".
  const { code, stderr } = cli(inputs());
  assert.equal(code, 2);
  assert.match(stderr, /cannot measure deploy staleness/);
});

test('--expect-failure passes on a refusal and fails on a measurement', () => {
  // The workflow's negative control. If the refusal path ever stops working, this
  // is what goes red while production is healthy — the correct way to find out.
  assert.equal(cli([...inputs(), '--expect-failure']).code, 0);
});
