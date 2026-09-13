/**
 * Playwright config for post-deploy smoke tests. Unlike the main config,
 * this one targets a deployed environment (no webServer, no devices matrix)
 * and runs a single Chromium worker against a real URL.
 *
 * Wired into the GHA pipeline as the final smoke step after cd-production.
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error('E2E_BASE_URL is required (e.g. https://familygreenhouse.net)');
}

export default defineConfig({
  testDir: '.',
  testMatch: ['post-deploy-smoke.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // `failOnFlakyTests` is deliberately NOT set, unlike ../../playwright.config.ts:
  // a red smoke-tests job rolls production back, and a smoke that failed once
  // against a release and then passed on the retry above is not by itself a
  // reason to revert it. The JSON report is what keeps that retry from reading
  // as a clean pass: scripts/smoke-flaky-report.mjs reads it, names every
  // retried test in the step summary, and cd-production.yml's `notify` job
  // fails the run on it without touching `rollback` (#703). Relative to this
  // file, so it lands at frontend/tests/e2e/smoke-results/results.json.
  reporter: process.env.CI
    ? [
        ['github'],
        ['json', { outputFile: 'smoke-results/results.json' }],
        ['html', { open: 'never' }],
      ]
    : 'html',
  timeout: 60_000,
  use: {
    baseURL,
    // A trace archives full request URLs. This suite exercises a presigned S3
    // PUT, so retaining a failure trace would persist its query credentials in
    // the CI artifact. Keep screenshots/video plus sanitized hostname/status
    // assertions instead.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
