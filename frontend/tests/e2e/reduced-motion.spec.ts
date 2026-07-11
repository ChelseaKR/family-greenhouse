import { test, expect, Page } from '@playwright/test';
import { uiLogin } from './helpers';

/**
 * Reduced-motion spec (A11Y-08, WCAG 2.3.3 Animation from Interactions).
 *
 * The app promises two layers of motion restraint:
 *
 *  1. Recurring animations are opt-in via Tailwind's `motion-safe:`
 *     variant (`motion-safe:animate-pulse` on the loading `Skeleton`) —
 *     under `prefers-reduced-motion: reduce` the animation class simply
 *     never applies. (The card entrance fade this spec originally
 *     targeted was removed outright by the 0.14.1 mobile-first rework;
 *     the skeleton pulse is the remaining `motion-safe:` surface.)
 *  2. A global rule in `src/index.css` freezes anything that animates
 *     unconditionally (e.g. the landing hero's `animate-sway` sprigs)
 *     by forcing `animation-duration: 0.01ms` / one iteration.
 *
 * Both layers were previously verified only by the manual checklist in
 * docs/accessibility.md; these tests pin them in CI. Each preference is
 * emulated per-page with `page.emulateMedia()` (the context-level
 * `reducedMotion` option is unreliable on the built-in `page` fixture —
 * see the note in playwright.config.ts).
 *
 * Reads only the shared seed account's data — no mutations, safe to run
 * in parallel with everything else.
 */

// The Tailwind class name contains a colon (`motion-safe:animate-pulse`),
// so match on the substring rather than fighting CSS escaping.
const PULSING_SKELETON = '[class*="animate-pulse"]';

/**
 * Hold every plants-list API response (backend on :4000; the glob's final
 * `*` cannot cross `/`, so `/plants/<id>` detail calls pass through) until
 * the returned release function is called — keeps the loading skeletons on
 * screen long enough to read their computed animation style. Register it
 * AFTER login: `page.goto('/plants')` is a full document load, so the query
 * cache starts empty and the gated request always precedes content.
 */
async function holdPlantsList(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('http://localhost:4000/plants*', async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

/** Computed animation-duration in ms. Engines normalize units differently
 *  (Chromium reports `0.01ms` as `1e-05s`), so compare numerically. */
function durationMs(value: string): number {
  const n = parseFloat(value);
  return value.trim().endsWith('ms') ? n : n * 1000;
}

test.describe('Reduced motion', () => {
  test('motion-safe skeleton pulse does not run under reduce', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await uiLogin(page);
    const release = await holdPlantsList(page);
    await page.goto('/plants');
    const skeleton = page.locator(PULSING_SKELETON).first();
    await skeleton.waitFor({ state: 'visible', timeout: 15000 });

    const animationName = await skeleton.evaluate((el) => getComputedStyle(el).animationName);
    release();
    expect(animationName, 'motion-safe: variant must not apply under reduce').toBe('none');
  });

  test('motion-safe skeleton pulse does run under no-preference', async ({ page }) => {
    // Guards the test above against passing vacuously (e.g. if the
    // animation were removed outright, or the selector went stale).
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await uiLogin(page);
    const release = await holdPlantsList(page);
    await page.goto('/plants');
    const skeleton = page.locator(PULSING_SKELETON).first();
    await skeleton.waitFor({ state: 'visible', timeout: 15000 });

    const animationName = await skeleton.evaluate((el) => getComputedStyle(el).animationName);
    release();
    expect(animationName).toBe('pulse');
  });

  test('always-on decorative animation is frozen by the global reduce rule', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // The hero sprigs sway unconditionally (`animate-sway`, 6s infinite)
    // and rely on the global @media rule to freeze — duration collapses
    // to 0.01ms and the infinite loop is cut to a single iteration.
    const sprig = page.locator('.animate-sway').first();
    await sprig.waitFor({ state: 'attached', timeout: 15000 });

    const style = await sprig.evaluate((el) => {
      const s = getComputedStyle(el);
      return { duration: s.animationDuration, iterations: s.animationIterationCount };
    });
    expect(durationMs(style.duration)).toBeLessThanOrEqual(0.01);
    expect(style.iterations).toBe('1');
  });

  test('always-on decorative animation sways under no-preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const sprig = page.locator('.animate-sway').first();
    await sprig.waitFor({ state: 'attached', timeout: 15000 });

    const style = await sprig.evaluate((el) => {
      const s = getComputedStyle(el);
      return { duration: s.animationDuration, iterations: s.animationIterationCount };
    });
    expect(durationMs(style.duration)).toBe(6000);
    expect(style.iterations).toBe('infinite');
  });
});
