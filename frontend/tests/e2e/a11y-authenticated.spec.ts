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
// Enforce the documented conformance bar: WCAG 2.2 AA. We do NOT assert AAA
// here — docs/accessibility.md is explicit that full Level-AAA is *not*
// claimed (e.g. 1.4.6 Contrast Enhanced 7:1 isn't met on the richer interior
// UI). Asserting AAA in CI was testing a promise we don't make, which kept
// this suite permanently red; AAA is pursued manually where feasible.
const ENFORCED_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoA11yViolations(page: import('@playwright/test').Page, label: string) {
  // Let entrance animations (`motion-safe:animate-fade-in` cards) finish
  // before sampling colors: axe computes blended colors from mid-animation
  // opacity, which reports the transient frame rather than the settled UI.
  // Poll until quiescent — cards mount progressively as queries resolve, so
  // a single getAnimations() snapshot misses late-starting fades. Infinite
  // animations (e.g. spinners) are excluded; their `finished` never settles.
  await page.evaluate(async () => {
    const finite = (a: Animation) => {
      const timing = a.effect?.getComputedTiming();
      return !!timing && timing.endTime !== Infinity;
    };
    const deadline = Date.now() + 3000;
    let calmFrames = 0;
    while (Date.now() < deadline && calmFrames < 2) {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === 'running' && finite(a));
      if (running.length === 0) {
        calmFrames += 1;
      } else {
        calmFrames = 0;
        await Promise.allSettled(running.map((a) => a.finished));
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
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
    // Wait for the form to be interactive before typing — the login route is
    // lazy-loaded, so the fields aren't there on first paint.
    const email = page.getByLabel(/email/i);
    await email.waitFor({ state: 'visible', timeout: 15000 });
    await email.fill('test@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
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
    const monstera = page.getByRole('link', { name: /Monstera/i }).first();
    await monstera.waitFor({ state: 'visible', timeout: 15000 });
    await monstera.click();
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
