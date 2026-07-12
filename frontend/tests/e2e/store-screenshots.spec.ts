import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const outputByProject: Record<string, string> = {
  'app-store-iphone': 'app-store/iphone-6.9',
  'app-store-ipad': 'app-store/ipad-13',
  'google-play-phone': 'google-play/phone',
};

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('test@example.com');
  await page.locator('input[name="password"]').fill('password123');
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
