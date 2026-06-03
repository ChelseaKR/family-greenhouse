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
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
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
