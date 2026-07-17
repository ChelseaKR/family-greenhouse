import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'shared-care-pulse',
    householdName: 'Shared Care Household',
    plant: { name: 'Kitchen Pothos', species: 'Epipremnum aureum' },
    waterTask: { frequency: 7 },
  });
});

test('guides a solo caregiver toward a shared routine and remembers dismissal', async ({
  page,
}) => {
  await uiLogin(page, account.email, account.password);

  const pulse = page.getByRole('region', {
    name: /make care something the household shares/i,
  });
  await expect(pulse).toBeVisible();
  await expect(pulse.getByText('2 of 4 steps ready')).toBeVisible();
  await expect(pulse.getByRole('listitem')).toHaveCount(4);
  await expect(pulse.getByRole('link', { name: 'Invite someone' })).toHaveAttribute(
    'href',
    '/household'
  );

  const accessibility = await new AxeBuilder({ page })
    .include('section[aria-labelledby="shared-care-pulse-title"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await pulse.getByRole('button', { name: /hide shared-care setup for 30 days/i }).click();
  await expect(pulse).toHaveCount(0);

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(pulse).toHaveCount(0);
});
