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
    // NOTE: the @playwright/test page fixture does not reliably apply this
    // option (manual newContext() does), so the a11y specs additionally
    // wait for document.getAnimations() to finish before running axe —
    // otherwise axe samples mid-fade opacity and reports blended colors as
    // contrast violations.
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
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
      use: { ...devices['Pixel 5'] },
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
            command: 'npm run dev',
            url: 'http://localhost:3000',
            reuseExistingServer: !process.env.CI,
          },
        ]),
  ],
});
