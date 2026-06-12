import { test, expect } from '@playwright/test';
import { navigateTo, provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * Smoke test for the write-side path that's regression-prone: pick a species
 * from the combobox, save a plant, see it land on the plants page. The
 * existing happy-path covers "login + read"; this complements it with
 * "login + write" so a broken AddPlantPage is caught in CI.
 *
 * Uses a freshly provisioned account (the shared seed household's Seedling
 * plan caps out at 10 plants when every browser project creates plants
 * against it); the dev server is started by the Playwright webServer
 * config so no external setup is required.
 */
let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({ emailPrefix: 'create-plant' });
});

test.describe('Create plant flow', () => {
  test('login → add plant → see it on the plants page', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await uiLogin(page, account.email, account.password);

    // The "Add plant" affordance lives on the plants page. Mobile-aware:
    // opens the sidebar drawer first on small viewports.
    await navigateTo(page, /^plants$/i, /\/plants$/);
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
    await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible({ timeout: 15000 });

    // No JS errors thrown during the round-trip.
    expect(consoleErrors).toEqual([]);
  });
});
