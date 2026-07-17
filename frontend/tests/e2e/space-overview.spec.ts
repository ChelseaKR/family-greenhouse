import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navigateTo, provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'space-overview',
    householdName: 'Route Test Household',
    space: {
      name: 'Living Room',
      environment: 'inside',
      lightLevel: 'bright',
      petAccess: false,
    },
    plant: { name: 'Monstera', species: 'Monstera deliciosa' },
    waterTask: { frequency: 7 },
  });
});

test('space overview deep-links into a scoped care round', async ({ page }) => {
  await uiLogin(page, account.email, account.password);
  await navigateTo(page, /^plants$/i, /\/plants$/);

  await page.getByRole('button', { name: /spaces view/i }).click();

  const roomCard = page.locator('article', {
    has: page.getByRole('heading', { name: 'Living Room' }),
  });
  await expect(roomCard.getByText(/care stop 1/i)).toBeVisible();
  await expect(roomCard.getByText(/1 due today/i)).toBeVisible();
  await expect(roomCard.getByText(/bright light/i)).toBeVisible();
  await expect(roomCard.getByText(/out of pet reach/i)).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await roomCard.getByRole('link', { name: /view care tasks/i }).click();

  await expect(page).toHaveURL(new RegExp(`/tasks\\?space=${account.spaceId}$`));
  await expect(page.getByText('Showing tasks in Living Room')).toBeVisible();
  await expect(page.getByRole('button', { name: /care round/i })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('link', { name: 'Monstera' })).toBeVisible();

  await page.getByRole('button', { name: /show all spaces/i }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByText('Showing tasks in Living Room')).toHaveCount(0);
});
