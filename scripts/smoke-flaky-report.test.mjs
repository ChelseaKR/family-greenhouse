// scripts/smoke-flaky-report.mjs and the cd-production.yml wiring around it (#703).
//
// The post-deploy smoke retries once and does not fail on a flaky result,
// because a failed smoke-tests job rolls production back. What stops a retried
// pass from reading as a clean one is three pieces that only work together:
// the JSON reporter in the smoke config, the report step inside smoke-tests,
// and the branch in `notify`. This file pins each piece, the path that ties
// the first two together, and the one property that must never change —
// nothing here can reach `rollback`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { load } from 'js-yaml';

import {
  UNKNOWN,
  annotations,
  main,
  outputValue,
  renderSummary,
  summarize,
} from './smoke-flaky-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_CONFIG = 'frontend/tests/e2e/playwright.smoke.config.ts';
const SECRET_LOOKING_ERROR =
  'expect failed at https://bucket.s3.amazonaws.com/x?X-Amz-Signature=abc';

// The shape @playwright/test 1.62.1 writes, recorded from a real run of a spec
// that throws on its first attempt and passes on its retry.
function report({ flakyTests = 1, nest = false, declared } = {}) {
  const flaky = Array.from({ length: flakyTests }, (_, i) => ({
    title: `signs in and loads the dashboard ${i}`,
    file: 'post-deploy-smoke.spec.ts',
    line: 40 + i,
    tests: [
      {
        projectName: 'chromium',
        status: 'flaky',
        results: [
          { status: 'failed', retry: 0, error: { message: SECRET_LOOKING_ERROR } },
          { status: 'passed', retry: 1 },
        ],
      },
    ],
  }));
  const clean = {
    title: 'public registration reaches confirmation',
    file: 'post-deploy-smoke.spec.ts',
    line: 12,
    tests: [
      { projectName: 'chromium', status: 'expected', results: [{ status: 'passed', retry: 0 }] },
    ],
  };
  const specs = [clean, ...flaky];
  const suites = nest
    ? [{ title: 'post-deploy-smoke.spec.ts', specs: [], suites: [{ title: 'inner', specs }] }]
    : [{ title: 'post-deploy-smoke.spec.ts', specs }];
  return {
    suites,
    stats: { expected: 1, unexpected: 0, skipped: 0, flaky: declared ?? flakyTests },
    errors: [],
  };
}

test('a clean smoke reads as zero retried tests', () => {
  const s = summarize(report({ flakyTests: 0 }));
  assert.equal(s.state, 'read');
  assert.equal(outputValue(s), '0');
  assert.match(renderSummary(s), /None: every smoke test passed on its first attempt/);
  assert.deepEqual(annotations(s), []);
});

test('a retried pass is counted and named, including in nested describe blocks', () => {
  for (const nest of [false, true]) {
    const s = summarize(report({ flakyTests: 2, nest }));
    assert.equal(s.state, 'read');
    assert.equal(outputValue(s), '2');
    assert.deepEqual(
      s.flaky.map((t) => [t.file, t.line, t.attempts]),
      [
        ['post-deploy-smoke.spec.ts', 40, 2],
        ['post-deploy-smoke.spec.ts', 41, 2],
      ]
    );
    assert.match(renderSummary(s), /\*\*2\*\* smoke test\(s\) failed against this deployment/);
    assert.equal(annotations(s).length, 2);
  }
});

test('error messages never reach the public step summary or annotations', () => {
  const s = summarize(report());
  assert.doesNotMatch(renderSummary(s), /X-Amz-Signature|amazonaws/);
  assert.doesNotMatch(annotations(s).join('\n'), /X-Amz-Signature|amazonaws/);
});

test('a report this cannot read is unknown, never zero', () => {
  const cases = [
    [null, /no `suites` array/],
    [{}, /no `suites` array/],
    [{ suites: [] }, /no integer `stats.flaky`/],
    [{ suites: [], stats: { flaky: '0' } }, /no integer `stats.flaky`/],
    // The walk and the declared count disagree: a changed report shape must
    // not be read as a measurement.
    [report({ flakyTests: 1, declared: 3 }), /stats.flaky is 3 but 1 flaky/],
  ];
  for (const [input, reason] of cases) {
    const s = summarize(input);
    assert.equal(s.state, 'unreadable');
    assert.match(s.reason, reason);
    assert.equal(outputValue(s), UNKNOWN);
    assert.match(renderSummary(s), /\*\*Unknown\.\*\*.*not reported as zero/s);
  }
});

test('workflow-command escaping keeps a title from breaking out of its annotation', () => {
  const s = {
    state: 'read',
    flaky: [{ title: 'a\nb: c, 100%', file: 'x.spec.ts', line: 1, project: '', attempts: 2 }],
  };
  const [line] = annotations(s);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /a%0Ab: c, 100%25 failed/);
});

function runMain(args, { outputIsDirectory = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-flaky-'));
  const GITHUB_OUTPUT = outputIsDirectory ? dir : join(dir, 'output');
  const GITHUB_STEP_SUMMARY = join(dir, 'summary.md');
  const logged = [];
  const code = main(args(dir), { GITHUB_OUTPUT, GITHUB_STEP_SUMMARY }, (l) => logged.push(l));
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    code,
    output: outputIsDirectory ? '' : read(GITHUB_OUTPUT),
    summary: read(GITHUB_STEP_SUMMARY),
    logged,
  };
}

test('main writes the count and the summary, and exits 0 on a retried pass', () => {
  const r = runMain((dir) => {
    const path = join(dir, 'results.json');
    writeFileSync(path, JSON.stringify(report()));
    return [path];
  });
  assert.equal(r.code, 0);
  assert.equal(r.output, 'flaky=1\n');
  assert.match(r.summary, /\*\*1\*\* smoke test\(s\)/);
  assert.ok(
    r.logged.some((l) =>
      l.startsWith('::warning file=frontend/tests/e2e/post-deploy-smoke.spec.ts,line=40')
    )
  );
});

test('main reports unknown and still exits 0 when the report is missing or corrupt', () => {
  const missing = runMain((dir) => [join(dir, 'absent.json')]);
  assert.equal(missing.code, 0);
  assert.equal(missing.output, `flaky=${UNKNOWN}\n`);
  assert.match(missing.summary, /no report at/);

  const corrupt = runMain((dir) => {
    const path = join(dir, 'results.json');
    writeFileSync(path, '{"suites": [');
    return [path];
  });
  assert.equal(corrupt.code, 0);
  assert.equal(corrupt.output, `flaky=${UNKNOWN}\n`);

  const noArg = runMain(() => []);
  assert.equal(noArg.code, 0);
  assert.equal(noArg.output, `flaky=${UNKNOWN}\n`);
});

test('main exits 0 even when it cannot write its own output', () => {
  const r = runMain(
    (dir) => {
      const path = join(dir, 'results.json');
      writeFileSync(path, JSON.stringify(report()));
      return [path];
    },
    { outputIsDirectory: true }
  );
  assert.equal(r.code, 0);
});

test('the CLI process itself exits 0 on a report it cannot read', () => {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/smoke-flaky-report.mjs'), '/nonexistent/results.json'],
    {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /passed only on their retry: unknown/);
});

// ---- the wiring ------------------------------------------------------------

function productionJobs() {
  return load(readFileSync(join(ROOT, '.github/workflows/cd-production.yml'), 'utf8')).jobs;
}

async function smokeReportPath() {
  process.env.CI = '1';
  // The smoke config refuses to load without a target. Nothing is contacted.
  process.env.E2E_BASE_URL ??= 'https://smoke-target.invalid';
  const configPath = join(ROOT, SMOKE_CONFIG);
  const config = (await import(pathToFileURL(configPath).href)).default;
  const json = [config.reporter].flat().find((r) => Array.isArray(r) && r[0] === 'json');
  assert.ok(
    json,
    `${SMOKE_CONFIG} writes no JSON report in CI, so the retry report has nothing to read`
  );
  assert.ok(json[1]?.outputFile, `${SMOKE_CONFIG}'s JSON reporter has no outputFile`);
  // Playwright resolves a reporter's outputFile against the config's directory.
  return relative(ROOT, join(dirname(configPath), json[1].outputFile));
}

test('the report step reads the file the smoke config writes, after the smoke has run, and cannot fail the job', async () => {
  const smoke = productionJobs()['smoke-tests'];
  const e2e = smoke.steps.findIndex((s) =>
    /playwright test --config tests\/e2e\/playwright\.smoke\.config\.ts/.test(s.run ?? '')
  );
  const idx = smoke.steps.findIndex((s) => s.id === 'smoke-flaky');
  assert.ok(e2e >= 0, 'smoke-tests no longer runs the smoke config');
  assert.ok(idx > e2e, 'the retry report must run after the smoke itself');

  const step = smoke.steps[idx];
  assert.equal(step.if, 'always()');
  assert.equal(step['continue-on-error'], true);
  const expected = await smokeReportPath();
  assert.equal(step.run.trim(), `node scripts/smoke-flaky-report.mjs ${expected}`);
  assert.equal(smoke.outputs?.flaky, '${{ steps.smoke-flaky.outputs.flaky }}');
});

test('rollback still reads only whether smoke-tests passed, never how', () => {
  const jobs = productionJobs();
  const cond = String(jobs.rollback.if);
  assert.match(cond, /needs\.smoke-tests\.result != 'success'/);
  // It may read other jobs' outputs (it reads terraform's snapshot flag); it
  // must not read anything smoke-tests reports about how it passed.
  assert.doesNotMatch(cond, /smoke-tests\.outputs|flaky/);
  for (const step of jobs.rollback.steps) {
    assert.doesNotMatch(JSON.stringify(step), /smoke-tests\.outputs|SMOKE_FLAKY|smoke-flaky/);
  }
});

// Runs notify's actual shell, not a description of it.
function notify(env) {
  const job = productionJobs().notify;
  const step = job.steps.find((s) => /SMOKE_RESULT/.test(s.run ?? ''));
  assert.equal(step.env.SMOKE_FLAKY, '${{ needs.smoke-tests.outputs.flaky }}');
  return spawnSync('bash', ['-c', step.run], {
    env: { PATH: process.env.PATH, VERSION: 'v9.9.9', ...env },
    encoding: 'utf8',
  });
}

test('notify fails the run on a retried or unreadable smoke and passes a clean one', () => {
  const kept = { SMOKE_RESULT: 'success', CLEANUP_RESULT: 'success', ROLLBACK_RESULT: 'skipped' };

  const clean = notify({ ...kept, SMOKE_FLAKY: '0' });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /successful!/);

  for (const SMOKE_FLAKY of ['1', '3', 'unknown', '']) {
    const r = notify({ ...kept, SMOKE_FLAKY });
    assert.equal(
      r.status,
      1,
      `SMOKE_FLAKY=${JSON.stringify(SMOKE_FLAKY)} must fail the run:\n${r.stdout}`
    );
    assert.match(r.stdout, /::warning::v9\.9\.9 was kept/);
    assert.doesNotMatch(r.stdout, /successful!/);
  }
});

test('notify keeps its existing verdicts for failed and rolled-back deploys', () => {
  const rolledBack = notify({
    SMOKE_RESULT: 'failure',
    CLEANUP_RESULT: 'skipped',
    ROLLBACK_RESULT: 'success',
    SMOKE_FLAKY: '',
  });
  assert.equal(rolledBack.status, 1);
  assert.match(rolledBack.stdout, /failed and was rolled back/);
  // A failed smoke is reported as a failed deploy, not as a retry.
  assert.doesNotMatch(rolledBack.stdout, /was kept/);

  const cleanupFailed = notify({
    SMOKE_RESULT: 'success',
    CLEANUP_RESULT: 'failure',
    ROLLBACK_RESULT: 'skipped',
    SMOKE_FLAKY: '0',
  });
  assert.equal(cleanupFailed.status, 1);
  assert.match(cleanupFailed.stdout, /retention cleanup failed/);
});
