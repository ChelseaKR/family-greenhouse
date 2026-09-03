import { test, expect } from '@playwright/test';
import { provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/** The catalog's capability flags per tier (backend/src/models/plans.ts). */
const OFF = {
  awayKit: false,
  householdToolkit: false,
  plantTags: false,
  crossHomeToday: false,
  kiosk: false,
  caretakerSeats: false,
  moveDay: false,
  chat: false,
  apiKeys: false,
};
const FEATURES = {
  seedling: { ...OFF },
  garden: {
    ...OFF,
    awayKit: true,
    householdToolkit: true,
    plantTags: true,
    moveDay: true,
    chat: true,
  },
  greenhouse: {
    ...OFF,
    awayKit: true,
    householdToolkit: true,
    plantTags: true,
    crossHomeToday: true,
    kiosk: true,
    caretakerSeats: true,
    moveDay: true,
    chat: true,
    apiKeys: true,
  },
};

/**
 * Regression coverage for the two states the public plan surface can be in.
 * The filename stays stable so existing CI project filters continue to
 * discover it.
 *
 * 1. Fail-closed. The repository hold is lifted, so this page now *tries* to
 *    publish the catalog — but the local stack runs without PAYMENTS_ENABLED,
 *    so the API reports paymentsAvailable: false and the page must fall back
 *    to the status notice. That is exactly the state production sits in until
 *    its own runtime gate opens, and it is the case worth guarding: no amount
 *    may reach a visitor the server will refuse to sell to.
 *
 * 2. Published, monthly only. Since 2026-09-02 the annual cadences and Garden
 *    lifetime are withdrawn from sale (`withdrawnIntervals` in
 *    backend/src/models/plans.ts). The API publishes them as `null`, and the
 *    page must read as a plain monthly price list: no billing-interval toggle,
 *    no yearly or one-time amount, no "not available" tab and no "coming back"
 *    note. The local API cannot open its runtime gate, so this test routes the
 *    catalog response to the exact shape production now publishes.
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

  test('publishes monthly prices only, with no interval toggle, once the API opens', async ({
    page,
  }) => {
    await page.route('http://localhost:4000/billing/plans', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          paymentsAvailable: true,
          commercialHold: { active: false, effectiveDate: '2026-09-01' },
          plans: [
            {
              id: 'seedling',
              name: 'Seedling',
              description: 'A couple and their plants',
              maxPlants: 20,
              maxMembers: 3,
              limits: {
                homes: 1,
                members: 3,
                plants: 20,
                tags: 0,
                analyticsHistoryDays: 30,
                sitterLinkMaxDays: 7,
                sitterLinksActive: 1,
              },
              features: FEATURES.seedling,
              monthlyPrice: 0,
              annualPrice: null,
              lifetimePrice: null,
            },
            {
              id: 'garden',
              name: 'Garden',
              description: 'A household that has to coordinate',
              maxPlants: 200,
              maxMembers: null,
              limits: {
                homes: 1,
                members: null,
                plants: 200,
                tags: 50,
                analyticsHistoryDays: null,
                sitterLinkMaxDays: 90,
                sitterLinksActive: null,
              },
              features: FEATURES.garden,
              monthlyPrice: 4.99,
              annualPrice: null,
              lifetimePrice: null,
            },
            {
              id: 'greenhouse',
              name: 'Greenhouse',
              description: 'Many homes, many hands',
              maxPlants: 5000,
              maxMembers: null,
              limits: {
                homes: null,
                members: null,
                plants: 5000,
                tags: null,
                analyticsHistoryDays: null,
                sitterLinkMaxDays: 90,
                sitterLinksActive: null,
              },
              features: FEATURES.greenhouse,
              monthlyPrice: 9.99,
              annualPrice: null,
              lifetimePrice: null,
            },
          ],
        }),
      })
    );
    await page.goto('/pricing');

    await expect(page.getByText('$4.99')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('$9.99')).toBeVisible();
    // Monthly is the only cadence, so there is nothing to toggle between.
    await expect(page.getByRole('group', { name: /billing interval/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /yearly|lifetime|monthly/i })).toHaveCount(0);
    // No trace of a cadence that cannot be bought — not as an amount, not as
    // a disabled tab, not as a promise.
    await expect(page.locator('body')).not.toContainText(/per year|\$39\.99|\$79\.99|\$149/);
    await expect(page.locator('body')).not.toContainText(/not available|coming (back )?soon/i);
    await expect(page.locator('body')).not.toContainText(/lifetime|yearly|annual/i);
    // The public CTA still sends visitors to registration, never to checkout.
    await expect(page.getByRole('link', { name: /choose garden/i })).toHaveAttribute(
      'href',
      '/register'
    );
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
