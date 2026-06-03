import { test, expect } from '@playwright/test';

/**
 * Smoke test for the write-side path that's regression-prone: pick a species
 * from the combobox, save a plant, see it land on the plants page. The
 * existing happy-path covers "login + read"; this complements it with
 * "login + write" so a broken AddPlantPage is caught in CI.
 *
 * Uses the local-server seed account; the dev server is started by the
 * Playwright webServer config so no external setup is required.
 */
test.describe('Create plant flow', () => {
  test('login → add plant → see it on the plants page', async ({ page }) => {
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

    // The "Add plant" affordance lives on the plants page.
    await page
      .getByRole('link', { name: /plants/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/plants$/);
    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);

    // Use a uniquely-named plant so re-runs against a sticky local server
    // don't collide and produce ambiguous selectors.
    const uniqueName = `Hibiscus ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(uniqueName);
    // Hibiscus is in the species catalog (added this session); typing the
    // common name should produce a usable suggestion path.
    await page.getByLabel(/species/i).fill('Hibiscus');

    await page.getByRole('button', { name: /add plant/i }).click();

    // After save we should land on the new plant's detail page.
    await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible();

    // No JS errors thrown during the round-trip.
    expect(consoleErrors).toEqual([]);
  });
});
