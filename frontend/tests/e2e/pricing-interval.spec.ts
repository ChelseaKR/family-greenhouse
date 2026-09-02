import { test, expect } from '@playwright/test';
import { provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * Regression coverage for the fail-closed half of the two-gate commercial
 * contract. The filename stays stable so existing CI project filters continue
 * to discover it.
 *
 * The repository hold is lifted, so this page now *tries* to publish the
 * catalog — but the local stack runs without PAYMENTS_ENABLED, so the API
 * reports paymentsAvailable: false and the page must fall back to the status
 * notice. That is exactly the state production sits in until its own runtime
 * gate opens, and it is the case worth guarding: no amount may reach a visitor
 * the server will refuse to sell to.
 */
test.describe('Public plan-status page', () => {
  test('publishes no price while the API withholds payment activity', async ({ page }) => {
    await page.goto('/pricing');

    await expect(
      page.getByRole('heading', { name: /payments are temporarily unavailable/i })
    ).toBeVisible({ timeout: 15000 });
    // The hold is lifted, so the notice must not cite it or its date.
    await expect(page.locator('body')).not.toContainText(/commercial hold effective/i);
    await expect(page.getByRole('group', { name: /billing interval/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /upgrade|subscribe|trial|choose/i })).toHaveCount(
      0
    );
    await expect(page.getByRole('link', { name: /sign up free/i })).toHaveAttribute(
      'href',
      '/register'
    );
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

    await expect(page.getByText(/paid plan changes are paused/i)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('group', { name: /billing interval/i })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /upgrade|subscribe|manage|switch to|buy /i })
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/\$\s*\d/);
  });
});
