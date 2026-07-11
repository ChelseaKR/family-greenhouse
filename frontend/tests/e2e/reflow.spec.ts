import { test, expect, Page } from '@playwright/test';
import { uiLogin } from './helpers';

/**
 * Reflow spec (A11Y-09, WCAG 1.4.10).
 *
 * At a 320 CSS px viewport (the criterion's equivalent of 400% zoom on
 * a 1280px desktop) content must reflow to a single column: no
 * two-dimensional scrolling, i.e. the page itself never scrolls
 * horizontally. Wide widgets (tables, charts) may scroll inside their
 * own containers — the assertion here is strictly page-level.
 *
 * 320×256 is the WCAG-named minimum box; docs/accessibility.md carried
 * this as a manual 400%-zoom checklist item until this spec pinned it.
 *
 * Read-only against the shared seed account — safe to run in parallel.
 */

test.use({ viewport: { width: 320, height: 256 } });

async function expectNoHorizontalOverflow(page: Page, label: string) {
  // Let late-mounting cards/images settle before measuring.
  await page.waitForLoadState('networkidle');
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow, `${label}: page must not scroll horizontally at 320px`).toBeLessThanOrEqual(0);
}

test.describe('Reflow at 320×256', () => {
  test('public pages reflow', async ({ page }) => {
    for (const route of ['/', '/login', '/register', '/forgot-password']) {
      await page.goto(route);
      await expectNoHorizontalOverflow(page, route);
    }
  });

  test('authenticated pages reflow', async ({ page }) => {
    await uiLogin(page);
    for (const route of [
      '/dashboard',
      '/plants',
      '/tasks',
      '/household',
      '/settings',
      '/analytics',
      '/help',
    ]) {
      await page.goto(route);
      await expectNoHorizontalOverflow(page, route);
    }
  });

  test('plant detail reflows', async ({ page }) => {
    await uiLogin(page);
    await page.goto('/plants');
    await page.waitForLoadState('networkidle');
    const monstera = page.getByRole('link', { name: /monstera/i }).first();
    await monstera.waitFor({ state: 'visible', timeout: 15000 });
    await monstera.click();
    await expectNoHorizontalOverflow(page, 'plant-detail');
  });
});
