import { test, expect } from '@playwright/test';
import { provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * Regression coverage for the repository-level commercial hold. The filename
 * stays stable so existing CI project filters continue to discover it.
 */
test.describe('Public plan-status page', () => {
  test('contains no pricing, interval selector, or acquisition link', async ({ page }) => {
    await page.goto('/pricing');

    await expect(
      page.getByRole('heading', { name: /paid plans and purchases are unavailable/i })
    ).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: /billing interval/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /upgrade|subscribe|trial/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /sign up|register/i })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\$\s*\d/);
  });
});

test.describe('In-app plan status', () => {
  let account: ProvisionedAccount;

  test.beforeAll(async () => {
    account = await provisionAccount({ emailPrefix: 'billing-hold' });
  });

  test('contains no pricing or billing-management control', async ({ page }) => {
    await uiLogin(page, account.email, account.password);
    await page.goto('/settings/billing');
    await expect(page).toHaveURL(/\/settings\/billing$/);

    await expect(page.getByText(/technical demo — plan changes paused/i)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('radiogroup', { name: /billing interval/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /upgrade|subscribe|manage/i })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\$\s*\d/);
  });
});
