import { defineConfig, devices } from '@playwright/test';

// Design/visual passes can point Playwright at an already-running Vite server
// when port 3000 is occupied (for example by an SSH tunnel in Codex desktop).
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  // `post-deploy-smoke.spec.ts` reaches Cognito directly at module load
  // and throws if E2E_USER_POOL_ID isn't set. It runs through its own
  // smoke config (tests/e2e/playwright.smoke.config.ts) on a cron, not
  // as part of the local + CI default e2e sweep.
  // These use dedicated configs: deployed Cognito smoke and deterministic
  // store screenshot device projects. Running either in the default browser
  // matrix gives them the wrong environment/project names.
  testIgnore: ['post-deploy-smoke.spec.ts', 'store-screenshots.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The app honors prefers-reduced-motion; prefer the calm rendering in tests.
    // The a11y specs additionally wait for document.getAnimations() to finish
    // before running axe — otherwise axe samples mid-fade opacity and reports
    // blended colors as contrast violations.
    // Reduced motion, at the ONE key Playwright actually reads. This used to be
    // `reducedMotion: 'reduce'` directly under `use`, which is not a member of
    // PlaywrightTestOptions in 1.62 — the runner accepted the config and
    // ignored the key. Measured, not inferred: with the old form a page
    // evaluating `matchMedia('(prefers-reduced-motion: reduce)').matches`
    // returned FALSE; under `contextOptions` it returns TRUE. The file was
    // outside tsconfig's `include` and outside the lint globs, so nothing
    // reported the dead key for as long as it sat there (#440).
    //
    // The NOTE this replaces read "the page fixture does not reliably apply
    // this option (manual newContext() does)" — that was the symptom of the
    // option never being applied at all. The a11y specs' waits on
    // document.getAnimations() stay: they are load-bearing regardless, and
    // nothing here should start depending on this option having been broken.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    {
      name: 'chromium',
      // The legacy headless shell hard-denies Notification permission even
      // after BrowserContext.grantPermissions(). Use full Chromium's new
      // headless mode so notification E2E exercises the real permission API.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'], channel: 'chromium' },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  webServer: [
    {
      command: 'ALLOW_TEST_ACCOUNT_PROVISIONING=1 npm --workspace backend run dev',
      url: 'http://localhost:4000/health',
      cwd: '..',
      reuseExistingServer: !process.env.CI,
    },
    ...(externalBaseURL
      ? []
      : [
          {
            // Exercise the production bundle and generated service worker.
            // Vite's dev-only Firefox parser uses eval (correctly blocked by
            // our production CSP), and hot-module invalidation can turn
            // parallel lazy-route requests into misleading import failures.
            command: 'npm run build && npm run preview',
            url: 'http://localhost:3000',
            reuseExistingServer: !process.env.CI,
          },
        ]),
  ],
});
