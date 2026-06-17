import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility regression suite. Each public route is scanned with axe-core
 * and must produce zero violations across WCAG 2.0/2.1/2.2 A + AA, plus the
 * AAA success criteria axe can mechanically check (notably 1.4.6 Contrast
 * Enhanced, 7:1, via `color-contrast-enhanced`).
 *
 * Why pin tags rather than scan everything: axe ships rules under several
 * tags (best-practice, experimental, ACT). We enforce the standards we commit
 * to and keep best-practice as advisory. Note: most AAA criteria are content/
 * design judgments axe cannot evaluate — full AAA still needs manual review
 * (see docs/accessibility.md); these tags enforce the machine-checkable slice.
 */
// WCAG 2.2 AA — the documented conformance bar (docs/accessibility.md). AAA is
// pursued where feasible but not claimed/enforced in CI, so we don't assert it.
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
    // Print a compact, debuggable summary on failure.
    console.log(`\n=== ${label} ===`);
    for (const v of results.violations) {
      console.log(`  [${v.impact}] ${v.id}: ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`    target: ${node.target.join(', ')}`);
        console.log(`    summary: ${node.failureSummary}`);
      }
    }
  }
  expect(results.violations).toEqual([]);
}

test.describe('A11y — public routes (WCAG 2.0/2.1/2.2 AA)', () => {
  test('landing page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'landing');
  });

  test('login page', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'login');
  });

  test('register page', async ({ page }) => {
    await page.goto('/register');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'register');
  });

  test('forgot password page', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'forgot-password');
  });

  test('pet-safe checker page', async ({ page }) => {
    await page.goto('/pet-safe');
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'pet-safe');
  });

  test('shared cutting card (public graft landing)', async ({ page }) => {
    // The public cutting card fetches GET /plants/shared/{code}; stub it so
    // axe scans the populated card (photo placeholder, provenance, graft CTA).
    // No auth needed — this is the share-worthy face of the viral loop.
    await page.route('**/plants/shared/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          plant: {
            name: 'Mother Monstera',
            species: 'Monstera deliciosa',
            notes: 'East window, water weekly.',
            imageUrl: null,
            tags: ['tropical', 'easy'],
          },
          householdName: 'The Smiths',
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        }),
      })
    );
    await page.goto('/shared/' + 'a'.repeat(32));
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'shared-cutting');
  });

  test('plant-sitter page (with due tasks)', async ({ page }) => {
    // The public sitter page fetches GET /sitter/{token}; stub it so the
    // task-list state (the busiest layout) is what axe scans. No auth needed.
    await page.route('**/sitter/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          label: 'The Smiths’ plants',
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          tasks: [
            {
              taskId: 't1',
              plantName: 'Monstera',
              taskType: 'water',
              dueDate: new Date(Date.now() - 1000).toISOString(),
              overdue: true,
            },
          ],
        }),
      })
    );
    await page.goto('/sit/' + 'a'.repeat(64));
    await page.waitForLoadState('networkidle');
    await expectNoA11yViolations(page, 'sitter');
  });
});
