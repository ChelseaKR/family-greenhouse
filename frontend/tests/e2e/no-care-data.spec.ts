import { test, expect, Page } from '@playwright/test';
import { provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * The "no care guide for this species yet" notice (NoCareDataNotice).
 *
 * PlantDetailPage shows it only when we have nothing to say about a plant's
 * species — no Perenual match (`perenualSpeciesId`) AND no curated care guide
 * (`findCareGuide`). The local backend never assigns a Perenual id, so the
 * notice hinges purely on whether the species matches a curated guide:
 *
 *   - "Testus fictus nonexistus" → no guide → notice shown.
 *   - "Monstera deliciosa"       → curated guide → notice hidden.
 *
 * The second case guards against a regression where the notice renders
 * unconditionally (which would hide the real care guide behind it).
 */

let unrecognized: ProvisionedAccount;
let recognized: ProvisionedAccount;

test.beforeAll(async () => {
  unrecognized = await provisionAccount({
    emailPrefix: 'no-care-data',
    plant: { name: 'Mystery Plant', species: 'Testus fictus nonexistus' },
  });
  recognized = await provisionAccount({
    emailPrefix: 'has-care-data',
    plant: { name: 'Front Window Monstera', species: 'Monstera deliciosa' },
  });
});

/** Log in, open the account's single plant from the plants list. */
async function openOnlyPlant(page: Page, account: ProvisionedAccount) {
  await uiLogin(page, account.email, account.password);
  await page.goto('/plants');
  // Click the plant card link (excludes the "/plants/new" Add button) rather
  // than page.goto('/plants/{id}') to dodge the zustand-persist rehydrate race.
  await page.locator('a[href^="/plants/"]:not([href$="/new"])').first().click();
  await expect(page).toHaveURL(/\/plants\/[^/]+$/);
}

test.describe('No-care-data notice', () => {
  test('shows for a plant whose species is not recognised', async ({ page }) => {
    await openOnlyPlant(page, unrecognized);

    await expect(
      page.getByRole('heading', { name: /no care guide for this species yet/i })
    ).toBeVisible({ timeout: 15000 });
  });

  test('is hidden for a plant with a curated care guide', async ({ page }) => {
    await openOnlyPlant(page, recognized);

    // The plant name renders first; wait for it so we don't assert absence
    // before the detail page has finished loading.
    await expect(page.getByRole('heading', { name: /front window monstera/i })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByRole('heading', { name: /no care guide for this species yet/i })
    ).toHaveCount(0);
  });
});
