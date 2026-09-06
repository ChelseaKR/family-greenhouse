import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'store-screenshots.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'line',
  // `reducedMotion` under `use` is not a PlaywrightTestOptions member in 1.62
  // and was silently ignored; `contextOptions` is where the runner reads it.
  // See playwright.config.ts and #440.
  use: { baseURL: 'http://localhost:4174', contextOptions: { reducedMotion: 'reduce' } },
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
      // SEED_STORE_DEMO adds the store-demo household — three named members,
      // eight plants across five rooms, a week of claimed/unclaimed work and
      // a month of care history — that store-screenshots.spec.ts signs into.
      // Without it the frames come from the one-plant `test@example.com`
      // fixture, which is what `store-assets/README.md` calls out as the
      // reason the current screenshots undersell the product.
      command: 'SEED_STORE_DEMO=1 npm --workspace backend run dev',
      url: 'http://localhost:4000/health',
      cwd: '..',
      // Reused, but not trusted: a server already up may have been started
      // without the flag, and capturing the default one-plant fixture by
      // accident is the whole defect this change exists to fix. The spec
      // probes for the demo account before it captures anything and fails
      // naming the flag, rather than shipping a frame that says
      // "Welcome back, Test". Reuse has to stay on because `tsx watch`
      // outlives the run that started it, so a false here makes the second
      // `npm run store:screenshots` of the day fail on a busy port.
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev -- --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: false,
    },
  ],
});
