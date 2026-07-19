import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Visual capture spec — sweeps every route in the app at desktop + mobile
 * sizes and dumps a full-page PNG to `tests/e2e/screenshots/`. Not a
 * regression suite (no baseline comparison). The output is what gets
 * eyeballed during a design pass to spot layout glitches: clipped art,
 * broken cards, palette drift, mobile reflow problems, etc.
 *
 * Run only this spec with:
 *   npx playwright test visual.spec.ts --project=chromium
 *
 * Backend is seeded with test@example.com / password123 + one "Monstera"
 * plant by `backend/src/local-server.ts`.
 */

const SCREENSHOT_DIR = path.join(process.cwd(), 'tests', 'e2e', 'screenshots');

// Routes the marketing site exposes without auth.
const PUBLIC_ROUTES: Array<{ name: string; path: string }> = [
  { name: 'landing', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'register', path: '/register' },
  { name: 'pricing', path: '/pricing' },
  { name: 'legal-privacy', path: '/legal/privacy' },
  { name: 'legal-terms', path: '/legal/terms' },
];

// Routes inside the authenticated shell.
const AUTH_ROUTES: Array<{ name: string; path: string }> = [
  { name: 'dashboard', path: '/dashboard' },
  { name: 'plants', path: '/plants' },
  { name: 'tasks', path: '/tasks' },
  { name: 'analytics', path: '/analytics' },
  { name: 'household', path: '/household' },
  { name: 'settings', path: '/settings' },
  { name: 'help', path: '/help' },
  { name: 'chat', path: '/chat' },
];

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;

function ensureDir() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function capture(page: Page, name: string, viewport: keyof typeof VIEWPORTS) {
  // Pause for fonts + lazy-loaded illustrations to settle. The dashboard
  // header art and Bitter serif need a beat or the first frame ships with
  // fallback fonts that misreport the layout.
  await page.waitForLoadState('networkidle').catch(() => {
    /* networkidle can hang on long-polled streams; the timeout is fine */
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  const file = path.join(SCREENSHOT_DIR, `${name}.${viewport}.png`);
  await page.screenshot({ path: file, fullPage: true });
}

test.describe('Visual capture — public pages', () => {
  test.describe.configure({ mode: 'serial' });

  for (const route of PUBLIC_ROUTES) {
    for (const [vp, size] of Object.entries(VIEWPORTS) as Array<
      [keyof typeof VIEWPORTS, (typeof VIEWPORTS)[keyof typeof VIEWPORTS]]
    >) {
      test(`${route.name} (${vp})`, async ({ page }) => {
        ensureDir();
        await page.setViewportSize(size);
        await page.goto(route.path);
        await capture(page, route.name, vp);
      });
    }
  }
});

test.describe('Visual capture — authenticated pages', () => {
  test.describe.configure({ mode: 'serial' });

  // Share login across the auth suite so we don't pay the auth roundtrip
  // per route. Playwright runs each test in a fresh context, so we
  // re-authenticate inside each spec body via a small helper rather than
  // a global `beforeAll`.
  async function login(page: Page) {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('test@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  }

  for (const route of AUTH_ROUTES) {
    for (const [vp, size] of Object.entries(VIEWPORTS) as Array<
      [keyof typeof VIEWPORTS, (typeof VIEWPORTS)[keyof typeof VIEWPORTS]]
    >) {
      test(`${route.name} (${vp})`, async ({ page }) => {
        ensureDir();
        await page.setViewportSize(size);
        await login(page);
        if (route.path !== '/dashboard') {
          // SPA navigation avoids the protected-route redirect race we
          // hit with `page.goto` (zustand-persist rehydrates async, and
          // the route guard fires before `isAuthenticated` re-reads from
          // localStorage on a hard nav). Mobile collapses the sidebar
          // into a Bars3 toggle; open it first.
          if (vp === 'mobile') {
            await page.getByRole('button', { name: /open sidebar/i }).click();
          }
          await page.getByRole('link', { name: new RegExp(`^${route.name}$`, 'i') }).click();
          await expect(page).toHaveURL(new RegExp(`${route.path}$`));
          if (vp === 'mobile') {
            // Wait for the drawer's self-close (NavLink onNavigate) to
            // finish so the capture shows the page, not a mid-fade
            // overlay.
            await page.getByRole('button', { name: /close sidebar/i }).waitFor({ state: 'hidden' });
          }
        }
        // Wait for the new page's PageHeader to render before screenshot.
        await page.locator('main h1, main h2').first().waitFor({ state: 'visible' });
        await capture(page, route.name, vp);
      });
    }
  }

  // Plant detail uses the seeded Monstera. The id isn't deterministic at
  // boot, so we navigate via the Plants list to discover it.
  for (const [vp, size] of Object.entries(VIEWPORTS) as Array<
    [keyof typeof VIEWPORTS, (typeof VIEWPORTS)[keyof typeof VIEWPORTS]]
  >) {
    test(`plant-detail (${vp})`, async ({ page }) => {
      ensureDir();
      await page.setViewportSize(size);
      await login(page);
      if (vp === 'mobile') {
        await page.getByRole('button', { name: /open sidebar/i }).click();
      }
      await page.getByRole('link', { name: /^plants$/i }).click();
      await expect(page).toHaveURL(/\/plants$/);
      if (vp === 'mobile') {
        // The drawer closes itself on nav (each NavLink's onNavigate sets
        // sidebarOpen false). Under react-router 7 navigation commits
        // inside React.startTransition, so the close runs to completion
        // and the "Close sidebar" button detaches mid-click if we try to
        // dismiss it manually (the pre-v7 behavior left the drawer stuck
        // open because the sync lazy-route suspend interrupted the leave
        // transition). Wait for the dialog to finish leaving so the plant
        // cards beneath are clickable.
        await page.getByRole('button', { name: /close sidebar/i }).waitFor({ state: 'hidden' });
      }
      // Plant cards are anchor wrappers around the image + name. The
      // selector excludes `/plants/new` (the "Add plant" button) so we
      // land on the seeded Monstera detail page.
      await page.locator('a[href^="/plants/"]:not([href$="/new"])').first().click();
      await expect(page).toHaveURL(/\/plants\/[^/]+$/);
      // The detail page renders the plant name as bold text rather than
      // a semantic heading, so we match on the visible "Back to plants"
      // affordance as a load signal instead.
      await page.getByText(/back to plants/i).waitFor({ state: 'visible' });
      await capture(page, 'plant-detail', vp);
    });
  }
});
