import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Authenticated route a11y. Logs in via the local-server's seed account
 * (test@example.com / password123 — see backend/src/local-server.ts) and
 * then scans every interior route with axe.
 *
 * The seed user has one plant ("Monstera") with one task already, so the
 * detail/tasks pages have something to render.
 *
 * If this suite ever runs against a non-local backend, the seed user won't
 * exist and the tests will fail at login. That's correct behavior — these
 * tests are for the local CI loop.
 */
// Includes the AAA criteria axe can mechanically check (notably 1.4.6
// Contrast Enhanced, 7:1). Full AAA still needs manual review — see
// docs/accessibility.md.
const ENFORCED_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag2aaa',
  'wcag21a',
  'wcag21aa',
  'wcag21aaa',
  'wcag22aa',
];

async function expectNoA11yViolations(page: import('@playwright/test').Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(ENFORCED_TAGS).analyze();
  if (results.violations.length > 0) {
    console.log(`\n=== ${label} ===`);
    for (const v of results.violations) {
      console.log(`  [${v.impact}] ${v.id}: ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`    target: ${node.target.join(', ')}`);
      }
    }
  }
  expect(results.violations).toEqual([]);
}

test.describe('A11y — authenticated routes', () => {
  // Login once per worker; reuse the storage state.
  test.use({ storageState: undefined });

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('test@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 10000 });
  });

  test('dashboard', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'dashboard');
  });

  test('plants list', async ({ page }) => {
    await page.goto('/plants');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'plants');
  });

  test('plant detail', async ({ page }) => {
    await page.goto('/plants');
    await page.waitForLoadState('networkidle');
    await page
      .getByRole('link', { name: /Monstera/i })
      .first()
      .click();
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'plant-detail');
  });

  test('tasks', async ({ page }) => {
    await page.goto('/tasks');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'tasks');
  });

  test('household', async ({ page }) => {
    await page.goto('/household');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'household');
  });

  test('settings → preferences', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'settings-preferences');
  });

  test('analytics', async ({ page }) => {
    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'analytics');
  });

  test('help', async ({ page }) => {
    await page.goto('/help');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'help');
  });
});
