import { test, expect, Page } from '@playwright/test';

/**
 * Plant create / edit / delete round-trip.
 *
 * Each test starts by logging in fresh via the UI (the local backend's
 * in-memory store survives across tests in a single worker, so we use
 * timestamp-suffixed plant names to keep each scenario isolated). SPA
 * navigation via the sidebar avoids the zustand-persist race that bites
 * `page.goto` calls to authenticated routes.
 */

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('test@example.com');
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function goToPlants(page: Page) {
  await page.getByRole('link', { name: /^plants$/i }).click();
  await expect(page).toHaveURL(/\/plants$/);
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
    await expect(page.getByRole('heading', { name: plantName })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('edit an existing plant → modal saves new name', async ({ page }) => {
    await login(page);
    await goToPlants(page);

    // Create a plant to edit so we don't mutate the seeded Monstera (other
    // specs assume it exists in its original shape).
    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);
    const originalName = `Editable ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(originalName);
    await page.getByRole('button', { name: /add plant/i }).click();
    await expect(page.getByRole('heading', { name: originalName })).toBeVisible();

    // Open the Edit plant modal from the detail page header.
    await page.getByRole('button', { name: /^edit$/i }).click();
    await expect(page.getByRole('heading', { name: /edit plant/i })).toBeVisible();

    const newName = `${originalName} (renamed)`;
    const nameField = page.getByLabel(/plant name/i);
    await nameField.fill(newName);

    await page.getByRole('button', { name: /save changes/i }).click();

    // Modal closes on success; the detail h1 reflects the new name once
    // the plants query invalidates and refetches.
    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  });

  test('delete a plant → confirm → land on plants list without it', async ({ page }) => {
    await login(page);
    await goToPlants(page);

    // Create a disposable plant so the delete doesn't yank the seeded
    // Monstera out from under other specs in the same worker run.
    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);
    const plantName = `Deletable ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(plantName);
    await page.getByRole('button', { name: /add plant/i }).click();
    await expect(page.getByRole('heading', { name: plantName })).toBeVisible();

    // Open the delete confirm dialog and confirm.
    await page.getByRole('button', { name: /^delete$/i }).click();
    // The ConfirmDialog title doubles as the dialog heading; matching it
    // anchors the dialog so the "Delete" button below is unambiguous.
    await expect(page.getByRole('heading', { name: /delete plant/i })).toBeVisible();
    // There are now two "Delete" buttons on the page (the trigger and the
    // dialog's confirm). Scope to the dialog to pick the confirm one.
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
