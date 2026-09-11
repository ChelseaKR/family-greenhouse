// Every Playwright config under frontend/ that retries in CI must fail the run
// on a flaky result, or be declared in EXEMPT with the reason it does not.
//
// Playwright reports a test that failed and then passed on a retry as `flaky`,
// and exits 0 on flaky unless `failOnFlakyTests` is set. With `retries` above
// zero in CI, that turns an intermittent failure into a green check. The
// weekly cross-browser sweep did exactly that on 2026-07-21, 2026-08-11 and
// 2026-08-18. This imports each config the way Playwright reads it, with CI
// set, rather than matching its text, so a key that is commented out,
// misspelt or set to `false` cannot satisfy it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.CI = '1';
// The post-deploy smoke config refuses to load without a target. Nothing is
// contacted; the value only lets the module evaluate.
process.env.E2E_BASE_URL ??= 'https://smoke-target.invalid';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXEMPT = {
  'frontend/tests/e2e/playwright.smoke.config.ts':
    'post-deploy smoke: a red run rolls production back, so failing it on a ' +
    'flaky result is an owner decision (#703)',
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'playwright-report', 'test-results']);

function findConfigs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findConfigs(join(dir, entry.name)));
    } else if (/^playwright(\.[a-z]+)?\.config\.ts$/.test(entry.name)) {
      found.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return found;
}

const CONFIGS = findConfigs(join(ROOT, 'frontend')).sort();

test('the configs checked below are the ones on disk', () => {
  assert.ok(
    CONFIGS.includes('frontend/playwright.config.ts'),
    `frontend/playwright.config.ts was not found among ${JSON.stringify(CONFIGS)}`
  );
  for (const name of Object.keys(EXEMPT)) {
    assert.ok(
      CONFIGS.includes(name),
      `${name} is exempted but no longer exists; delete the exemption`
    );
  }
});

for (const name of CONFIGS) {
  test(`${name}: a CI run that retries fails when a retry was needed`, async () => {
    const config = (await import(pathToFileURL(join(ROOT, name)).href)).default;
    const retries = config.retries ?? 0;
    const failsOnFlaky = retries === 0 || config.failOnFlakyTests === true;
    if (name in EXEMPT) {
      assert.ok(
        !failsOnFlaky,
        `${name} now satisfies the rule; delete its exemption (${EXEMPT[name]})`
      );
      return;
    }
    assert.ok(
      failsOnFlaky,
      `${name} retries ${retries} time(s) in CI but does not set failOnFlakyTests: true, ` +
        'so a test that passes only on its retry reads as green'
    );
  });
}
