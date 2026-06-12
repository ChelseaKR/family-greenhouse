import { test, expect, Page } from '@playwright/test';
import { provisionAccount, ProvisionedAccount } from './helpers';

/**
 * Visual regression spec — narrow companion to `visual.spec.ts`. Where
 * that file dumps screenshots for human review, this one is the CI gate:
 * `toHaveScreenshot()` compares the live render against a baseline PNG
 * stored next to the spec at `visual-regression.spec.ts-snapshots/` and
 * fails the build on perceptible drift.
 *
 * Scope is intentionally narrow — five canonical pages × two viewports —
 * so the snapshot set stays small enough to review in a PR and stable
 * enough that flake doesn't drown out real regressions. The exploratory
 * spec stays the place to inspect every route during a redesign.
 *
 * To update baselines after an intentional UI change:
 *   npx playwright test visual-regression.spec.ts --update-snapshots
 *
 * Run with:
 *   npx playwright test visual-regression.spec.ts --project=chromium
 *
 * **CI note**: Playwright snapshots are platform-specific (the file name
 * encodes `chromium-darwin` / `chromium-linux`). The baselines committed
 * today were generated on macOS; CI runs on Linux. Until Linux baselines
 * are generated on a CI runner and committed, this spec is skipped in
 * `process.env.CI` to keep PRs green. Re-enable by deleting the skip
 * once Linux baselines exist.
 */

test.skip(
  Boolean(process.env.CI),
  'Visual regression baselines are macOS-only today; regenerate on a Linux runner before enabling in CI.'
);

const DESKTOP = { width: 1280, height: 800 } as const;
const MOBILE = { width: 390, height: 844 } as const;

async function settle(page: Page) {
  // Wait for fonts + lazy-loaded illustrations to paint before the
  // snapshot fires. Without this, the first frame ships with fallback
  // fonts and the Gloock-vs-Georgia metric difference is enough to fail
  // the pixel diff every run.
  await page.waitForLoadState('networkidle').catch(() => {
    /* networkidle can hang on long-poll endpoints; the timeout is fine */
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

// Threshold tuned to absorb a few pixels of antialiasing drift around
// Gloock characters + the hand-drawn SVG strokes without giving real
// layout shifts a free pass. 0.02 = 2% of pixels may differ.
const screenshotOptions = {
  maxDiffPixelRatio: 0.02,
  animations: 'disabled' as const,
  fullPage: true,
};

test.describe('Visual regression — public pages', () => {
  test.describe.configure({ mode: 'serial' });

  const pages = [
    { name: 'landing', path: '/' },
    { name: 'login', path: '/login' },
    { name: 'register', path: '/register' },
  ];

  for (const { name, path } of pages) {
    test(`${name} (desktop)`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.goto(path);
      await settle(page);
      await expect(page).toHaveScreenshot(`${name}-desktop.png`, screenshotOptions);
    });

    test(`${name} (mobile)`, async ({ page }) => {
      await page.setViewportSize(MOBILE);
      await page.goto(path);
      await settle(page);
      await expect(page).toHaveScreenshot(`${name}-mobile.png`, screenshotOptions);
    });
  }
});

test.describe('Visual regression — authenticated pages', () => {
  test.describe.configure({ mode: 'serial' });

  // A dedicated, freshly provisioned account mirrors the shared seed's
  // shape (Test User / Test Household / one Monstera with a water task)
  // WITHOUT sharing its data. The seed account is mutated by the CRUD and
  // task-completion specs running in parallel across browser projects, so
  // snapshotting it makes the dashboard nondeterministic. The water task's
  // nextDue is pinned to the same instant as the mocked clock below, so
  // "due today" renders identically on every run, on any day.
  let account: ProvisionedAccount;

  test.beforeAll(async () => {
    account = await provisionAccount({
      emailPrefix: 'visual-regression',
      name: 'Test User',
      householdName: 'Test Household',
      plant: {
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
        notes: 'Needs indirect light',
      },
      waterTask: { frequency: 7, nextDue: '2026-06-02T15:00:00Z' },
    });
  });

  async function login(page: Page) {
    // Pin the clock to a fixed moment before navigation so that
    // time-dependent strings ("Today", "Tomorrow", relative dates on
    // tasks) render identically across runs. Without this, the
    // dashboard's task-due chip flips between values each invocation
    // and the snapshot diff trips on the date label alone.
    await page.clock.install({ time: new Date('2026-06-02T15:00:00Z') });
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(account.email);
    await page.getByLabel(/password/i).fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  }

  // The provisioned account's email is unique per run; mask the sidebar
  // line that renders it so the snapshot stays byte-stable.
  function maskedOptions(page: Page) {
    return { ...screenshotOptions, mask: [page.getByText(account.email)] };
  }

  const pages = [
    { name: 'dashboard', path: '/dashboard' },
    { name: 'plants', path: '/plants' },
  ];

  for (const { name, path } of pages) {
    test(`${name} (desktop)`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await login(page);
      if (path !== '/dashboard') {
        // SPA navigation — `page.goto` to a protected route races with
        // zustand-persist rehydration and bounces to /login.
        await page.getByRole('link', { name: new RegExp(`^${name}$`, 'i') }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
      }
      await settle(page);
      await expect(page).toHaveScreenshot(`${name}-desktop.png`, maskedOptions(page));
    });

    test(`${name} (mobile)`, async ({ page }) => {
      await page.setViewportSize(MOBILE);
      await login(page);
      if (path !== '/dashboard') {
        await page.getByRole('button', { name: /open sidebar/i }).click();
        await page.getByRole('link', { name: new RegExp(`^${name}$`, 'i') }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        // The mobile sidebar Dialog doesn't auto-close on internal nav;
        // dismiss so it isn't on top of the captured page.
        await page.getByRole('button', { name: /close sidebar/i }).click();
        await page.getByRole('button', { name: /close sidebar/i }).waitFor({ state: 'hidden' });
      }
      await settle(page);
      await expect(page).toHaveScreenshot(`${name}-mobile.png`, maskedOptions(page));
    });
  }
});
