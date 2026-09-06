import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const outputByProject: Record<string, string> = {
  'app-store-iphone': 'app-store/iphone-6.9',
  'app-store-ipad': 'app-store/ipad-13',
  'google-play-phone': 'google-play/phone',
};

const API_URL = 'http://localhost:4000';

/**
 * The store-demo household, not the default `test@example.com` seed: three
 * named members, eight plants across five rooms, and a mix of claimed,
 * up-for-grabs and completed work, so the shared-household pitch is actually
 * visible in the frames (backend/src/local-server-store-demo.ts).
 */
const DEMO = { email: 'dana@example.com', password: 'password123' };

async function login(page: Page) {
  // Probe the API first. The config reuses an already-running backend, and one
  // started without SEED_STORE_DEMO=1 has no demo household at all — capturing
  // it would quietly reproduce the one-plant "Welcome back, Test" frames these
  // assets exist to replace. Failing here names the cause; failing on the
  // dashboard URL assertion below would not.
  const probe = await page.request.post(`${API_URL}/auth/login`, { data: DEMO });
  expect(
    probe.ok(),
    `No store-demo household on ${API_URL}. It is seeded only when the API is started with ` +
      'SEED_STORE_DEMO=1 (playwright.store.config.ts does that). Stop any dev server already ' +
      'holding port 4000 and re-run.'
  ).toBeTruthy();

  await page.goto('/login');
  await page.getByLabel(/email/i).fill(DEMO.email);
  await page.locator('input[name="password"]').fill(DEMO.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function openNav(page: Page, label: RegExp) {
  const menu = page.getByRole('button', { name: /open sidebar/i });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: label }).click();
  const close = page.getByRole('button', { name: /close sidebar/i });
  if (await close.count()) await close.waitFor({ state: 'hidden' });
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

test('capture review-safe store screenshots', async ({ page }, testInfo) => {
  const output = outputByProject[testInfo.project.name];
  if (!output) throw new Error(`No screenshot output for ${testInfo.project.name}`);
  const directory = path.resolve(process.cwd(), '..', 'store-assets', output);
  await mkdir(directory, { recursive: true });

  await login(page);
  await settle(page);
  await page.screenshot({ path: path.join(directory, '01-dashboard.png') });

  await openNav(page, /^plants$/i);
  await expect(page).toHaveURL(/\/plants$/);
  await settle(page);
  await page.screenshot({ path: path.join(directory, '02-plants.png') });

  await page.locator('a[href^="/plants/"]:not([href$="/new"])').first().click();
  await page.getByText(/back to plants/i).waitFor({ state: 'visible' });
  await settle(page);
  await page.screenshot({ path: path.join(directory, '03-plant-detail.png') });

  await openNav(page, /^tasks$/i);
  await expect(page).toHaveURL(/\/tasks$/);
  await settle(page);
  await page.screenshot({ path: path.join(directory, '04-tasks.png') });
});
