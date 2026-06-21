import { test, expect, Page } from '@playwright/test';
import { provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * Billing-interval toggle (Monthly / Annual / Lifetime) on both surfaces it
 * ships on:
 *
 *   1. The public `/pricing` marketing grid (PricingGrid), which reads its
 *      copy from `features/pricing/plans.ts`. No auth, no backend.
 *   2. The in-app Billing settings (BillingSettings), which prices its cards
 *      off the live `GET /billing/plans` contract.
 *
 * Both default to Annual. Lifetime is Garden-only: on the public grid the
 * other tiers say "No lifetime option — annual price shown"; in-app they
 * silently fall back to the annual price (effectiveInterval).
 *
 * Prices are the single source of truth in `plans.ts` (marketing) and
 * `backend/src/models/plans.ts` (Garden: $4.99/mo, $39.99/yr, $149 lifetime);
 * if those change, update the figures here.
 */

test.describe('Pricing page billing interval toggle', () => {
  test('Monthly / Annual / Lifetime switch the Garden price', async ({ page }) => {
    await page.goto('/pricing');

    const group = page.getByRole('radiogroup', { name: /billing interval/i });
    await expect(group).toBeVisible();

    // Annual is the default cadence.
    await expect(page.getByRole('radio', { name: 'annual' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(page.getByText('$39.99')).toBeVisible();
    await expect(page.getByText('save 33%').first()).toBeVisible();
    await expect(page.getByText(/save ~33% yearly/i)).toBeVisible();

    // Monthly.
    await page.getByRole('radio', { name: 'monthly' }).click();
    await expect(page.getByText('$4.99')).toBeVisible();
    await expect(page.getByText('$39.99')).toHaveCount(0);

    // Lifetime — Garden shows the one-time price; Greenhouse, which has no
    // lifetime option, says so explicitly rather than passing its annual
    // figure off as a lifetime deal.
    await page.getByRole('radio', { name: 'lifetime' }).click();
    await expect(page.getByText('$149')).toBeVisible();
    await expect(page.getByText(/garden only · pay once/i)).toBeVisible();
    await expect(page.getByText(/no lifetime option/i)).toBeVisible();
  });
});

test.describe('In-app billing interval toggle', () => {
  let account: ProvisionedAccount;

  test.beforeAll(async () => {
    account = await provisionAccount({ emailPrefix: 'billing-toggle' });
  });

  async function goToBilling(page: Page) {
    // uiLogin lands on /dashboard, so the auth store is hydrated before we
    // navigate to the (authenticated) settings route — no zustand-persist race.
    await uiLogin(page, account.email, account.password);
    await page.goto('/settings');
    // SettingsPage tabs are local state, not URL-synced, so open Billing by
    // clicking the tab rather than relying on the /settings/billing path.
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    await expect(page.getByRole('radiogroup', { name: /billing interval/i })).toBeVisible({
      timeout: 15000,
    });
  }

  test('Monthly / Annual / Lifetime reprice the Garden card', async ({ page }) => {
    await goToBilling(page);

    // Scope to the Garden card — Greenhouse shares the "/ year" + "billed
    // yearly" wording, so page-level text queries would be ambiguous.
    const garden = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Garden', exact: true }) })
      .last();

    // Annual default: yearly headline + "billed yearly" sub-line.
    await expect(page.getByRole('radio', { name: 'Annual' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(garden.getByText('$39.99')).toBeVisible();
    await expect(garden.getByText(/billed yearly/i)).toBeVisible();

    // Monthly.
    await page.getByRole('radio', { name: 'Monthly' }).click();
    await expect(garden.getByText('$4.99')).toBeVisible();
    await expect(garden.getByText(/billed yearly/i)).toHaveCount(0);

    // Lifetime — Garden becomes a one-time charge.
    await page.getByRole('radio', { name: 'Lifetime' }).click();
    await expect(garden.getByText('$149')).toBeVisible();
    await expect(garden.getByText(/one-time payment/i)).toBeVisible();
  });
});
