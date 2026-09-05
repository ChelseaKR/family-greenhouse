#!/usr/bin/env node
/**
 * Loads `tests/e2e/post-deploy-smoke.spec.ts` through Playwright's own runner
 * and asserts that it still registers its tests — without running them.
 *
 * ## Why (#440)
 *
 * `post-deploy-smoke.spec.ts` is the only code in this repo that can revert a
 * production release: `cd-production.yml` fires its `rollback` job on any
 * non-success from the smoke job, which reverts the Lambda versions, restores
 * the frontend S3 snapshot and restores the Cognito registration policy. A red
 * smoke run is therefore not "a test failed" — it is a good release deploying
 * and then un-deploying itself, with a production blip in the middle.
 *
 * And until #440 the spec ran in exactly one environment: production, after
 * the deploy. `playwright.config.ts` puts it in `testIgnore`, so the PR e2e
 * job skips it; `tsconfig.json` includes only `src`, so it was never compiled;
 * the lint globs were `src/**`, so it was never linted. #394 moved the
 * post-signup destination to `/welcome` while the spec still asserted the old
 * URL, and the next tag would have deployed a working release and rolled it
 * back (PR #439).
 *
 * ## What this proves, and what it does NOT
 *
 * PROVES: the file and everything it imports still parse and load; the
 * `@playwright/test` API it calls still exists; its module-level environment
 * contract is still satisfiable; `test()` registration runs; the expected
 * specs are still registered under the smoke config.
 *
 * DOES NOT PROVE: that any assertion inside a test is still true. A stale
 * `toHaveURL(/\\/dashboard$/)` parses perfectly. Static checking cannot catch a
 * stale assertion — that is a real limit of this gate and it is stated here
 * rather than left for someone to discover after a rollback. The typecheck
 * (`tsconfig.e2e.json`) and lint globs added alongside this cover the rest of
 * what rots in these files: renamed helpers, wrong Playwright API usage, dead
 * imports, signature drift.
 *
 * The environment variables below are deliberate placeholders. `--list` never
 * opens a browser and never reaches the network; they exist only because
 * `playwright.smoke.config.ts` throws at module load without `E2E_BASE_URL`,
 * and the spec reads its Cognito/API settings at module load. Nothing here
 * resolves to a real endpoint — `.invalid` is reserved by RFC 2606 precisely
 * so it cannot.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'tests/e2e/playwright.smoke.config.ts';

/** Specs the smoke config must still register. A silent drop to zero here would
 *  mean production is deploying with no smoke coverage while the job goes
 *  green, so the count is asserted rather than assumed. */
const EXPECTED_SPEC_TITLES = [
  'public /register reaches an unconfirmed, confirmation-ready Cognito account',
  'fresh user → onboarding → real S3 plant photo renders cleanly',
];

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', CONFIG, '--list', '--reporter', 'list'],
  {
    cwd: FRONTEND,
    encoding: 'utf8',
    env: {
      ...process.env,
      // RFC 2606 reserved TLD: these cannot resolve.
      E2E_BASE_URL: 'https://smoke-parse-check.invalid',
      E2E_API_URL: 'https://smoke-parse-check.invalid/api',
      E2E_USER_POOL_ID: 'us-east-1_parsecheck',
      E2E_TABLE_NAME: 'family-greenhouse-smoke-parse-check',
      E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE: 'smoke-parse+{tag}@smoke-parse-check.invalid',
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      // Never let a parse check pick up a real profile's credentials.
      AWS_PROFILE: '',
      CI: process.env.CI ?? '',
    },
  }
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.error) {
  console.error(`check-smoke-spec-parses: could not run Playwright: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `The post-deploy smoke spec no longer loads. It is the spec whose failure ROLLS BACK a\n` +
      `production release, and it runs nowhere else, so a load error here would otherwise be\n` +
      `discovered by production (#440).\n\n` +
      `  npx playwright test --config ${CONFIG} --list\n`
  );
  console.error(output);
  process.exit(result.status ?? 1);
}

const missing = EXPECTED_SPEC_TITLES.filter((title) => !output.includes(title));
if (missing.length > 0) {
  console.error(
    'The post-deploy smoke spec loaded but no longer registers the tests this check expects.\n' +
      'A suite that silently registers nothing passes its CI job while covering nothing, and\n' +
      'the production deploy that follows would be unsmoked (#440):\n'
  );
  for (const title of missing) console.error(`  missing: ${title}`);
  console.error('\nPlaywright reported:\n');
  console.error(output);
  console.error(
    'If a spec was renamed or added on purpose, update EXPECTED_SPEC_TITLES in\n' +
      'frontend/scripts/check-smoke-spec-parses.mjs to match.'
  );
  process.exit(1);
}

console.log(
  `Post-deploy smoke spec loads and registers ${EXPECTED_SPEC_TITLES.length} tests ` +
    '(parse + registration only — this cannot detect a stale assertion).'
);
