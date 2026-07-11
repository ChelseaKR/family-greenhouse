import { test, expect, Page } from '@playwright/test';
import { navigateTo, provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * Plant create / edit / delete round-trip.
 *
 * The spec provisions its own account per worker: the shared seed
 * household is capped at 10 plants by the Seedling plan, so five browser
 * projects each creating plants against it exhausts the quota mid-run.
 * Timestamp-suffixed plant names keep each scenario isolated within the
 * account. SPA navigation via the sidebar avoids the zustand-persist race
 * that bites `page.goto` calls to authenticated routes.
 */

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({ emailPrefix: 'plant-crud' });
});

async function login(page: Page) {
  await uiLogin(page, account.email, account.password);
}

async function goToPlants(page: Page) {
  // Mobile-aware: opens the sidebar drawer first on small viewports.
  await navigateTo(page, /^plants$/i, /\/plants$/);
}

test.describe('Plant CRUD', () => {
  test('create a new plant → land on detail with the chosen name', async ({ page }) => {
    // Only watch for thrown errors (not React dev warnings) — the species
    // combobox emits a known dup-key warning when the species catalog
    // contains repeats, which is unrelated to the create round-trip.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await login(page);
    await goToPlants(page);

    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);

    const plantName = `Pothos ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(plantName);
    await page.getByLabel(/species/i).fill('Epipremnum aureum');

    await page.getByRole('button', { name: /add plant/i }).click();

    // After save we land on /plants/{id} — the detail page renders the
    // plant name as an h1.
    await expect(page).toHaveURL(/\/plants\/[^/]+$/);
    await expect(page.getByRole('heading', { name: plantName })).toBeVisible({ timeout: 15000 });
    expect(pageErrors).toEqual([]);
  });

  test('edit an existing plant → modal saves new name', async ({ page }) => {
    await login(page);
    await goToPlants(page);

    // Create a plant to edit so each scenario works on its own data.
    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);
    const originalName = `Editable ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(originalName);
    await page.getByRole('button', { name: /add plant/i }).click();
    await expect(page.getByRole('heading', { name: originalName })).toBeVisible({ timeout: 15000 });

    // Open the Edit plant modal from the detail page header.
    await page.getByRole('button', { name: /^edit$/i }).click();
    await expect(page.getByRole('heading', { name: /edit plant/i })).toBeVisible();

    const newName = `${originalName} (renamed)`;
    const nameField = page.getByLabel(/plant name/i);
    await nameField.fill(newName);

    await page.getByRole('button', { name: /save changes/i }).click();

    // Modal closes on success; the detail h1 reflects the new name once
    // the plants query invalidates and refetches.
    await expect(page.getByRole('heading', { name: newName })).toBeVisible({ timeout: 15000 });
  });

  test('archive a plant → find it in past plants → restore it', async ({ page }) => {
    await login(page);
    await goToPlants(page);

    await page.getByRole('link', { name: /add plant/i }).click();
    const plantName = `Archiveable ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(plantName);
    await page.getByRole('button', { name: /add plant/i }).click();
    await expect(page.getByRole('heading', { name: plantName })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^remove$/i }).click();
    await page.getByRole('button', { name: /archive for later/i }).click();

    await expect(page).toHaveURL(/\/plants$/);
    await page.getByRole('tab', { name: /past plants/i }).click();
    const archivedPlant = page.getByRole('link', { name: new RegExp(plantName, 'i') });
    await expect(archivedPlant).toBeVisible();
    await expect(archivedPlant.getByText('Archived')).toBeVisible();

    await archivedPlant.click();
    await expect(page.getByText('Archived', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^restore$/i }).click();
    await expect(page.getByText('Archived', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Plant restored')).toBeVisible();
  });

  test('delete a plant → confirm → land on plants list without it', async ({ page }) => {
    await login(page);
    await goToPlants(page);

    // Create a disposable plant so the delete works on its own data.
    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);
    const plantName = `Deletable ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(plantName);
    await page.getByRole('button', { name: /add plant/i }).click();
    await expect(page.getByRole('heading', { name: plantName })).toBeVisible({ timeout: 15000 });

    // The lifecycle feature (#37) replaced the bare "Delete" button with a
    // "Remove" flow: Remove → outcome dialog → "Delete permanently" →
    // explicit ConfirmDialog. Walk the full flow.
    await page.getByRole('button', { name: /^remove$/i }).click();
    await expect(
      page.getByRole('heading', { name: /move .* out of active care\?/i })
    ).toBeVisible();
    await page.getByRole('button', { name: /delete permanently/i }).click();
    // The ConfirmDialog title doubles as the dialog heading; matching it
    // anchors the dialog so the "Delete" button below is unambiguous.
    await expect(page.getByRole('heading', { name: /delete plant/i })).toBeVisible();
    // Scope to the dialog to pick the confirm button unambiguously.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^delete$/i })
      .click();

    // Successful delete navigates back to /plants and the now-gone plant
    // should not be in the list.
    await expect(page).toHaveURL(/\/plants$/);
    await expect(page.getByRole('link', { name: new RegExp(plantName, 'i') })).toHaveCount(0);
  });
});
