import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers';

// This suite assumes the local Express dev server is running on :4000
// (npm --workspace backend run dev) AND the Vite dev server on :3000.
// The seeded test account is test@example.com / password123 with one plant
// "Monstera" pre-loaded into the household.

test.describe('Happy path', () => {
  test('login → dashboard → plant detail loads without errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/login');
    await page.getByLabel(/email/i).fill('test@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/dashboard/);

    // Mobile-aware: opens the sidebar drawer first on small viewports.
    await navigateTo(page, /^plants$/i, /\/plants$/);
    await page
      .getByRole('link', { name: /Monstera/i })
      .first()
      .click();

    // exact: true — the species-care card adds a "Caring for Monstera"
    // heading that the default substring match would also hit.
    await expect(page.getByRole('heading', { name: 'Monstera', exact: true })).toBeVisible();
    // Regression: this page used to crash with TypeError on plant.upcomingTasks.length.
    expect(consoleErrors.filter((e) => /upcomingTasks/i.test(e))).toEqual([]);
  });

  test('rejects bad credentials and stays on /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('test@example.com');
    await page.getByLabel(/password/i).fill('definitely-wrong');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
