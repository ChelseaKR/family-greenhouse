import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'store-screenshots.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'line',
  use: { baseURL: 'http://localhost:4174', reducedMotion: 'reduce' },
  projects: [
    {
      name: 'app-store-iphone',
      use: {
        browserName: 'webkit',
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'app-store-ipad',
      use: {
        browserName: 'webkit',
        viewport: { width: 1032, height: 1376 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'google-play-phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: 'npm --workspace backend run dev',
      url: 'http://localhost:4000/health',
      cwd: '..',
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev -- --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: false,
    },
  ],
});
