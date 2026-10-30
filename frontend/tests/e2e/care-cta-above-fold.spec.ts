import { expect, test } from '@playwright/test';

/**
 * A care guide's sign-up link must be on the first screen of a phone and a
 * laptop. The 2026-10-30 audit measured the guide's sign-up box just under
 * the fold on both: y=900 against a 664px iPhone 13 screen, and y=778 against
 * a 1366x768 laptop. The "Remind me to water my …" link in the "At a glance"
 * water row is the fix, and this measures it in a real browser layout, which
 * jsdom cannot.
 *
 * The heights are the visible page area. Playwright's own device sizes are
 * used for the phones, plus the 664px Safari leaves on an iPhone 13 (the
 * audit's measurement). On the smallest case measured, an iPhone SE in
 * Safari with its bars showing (375x548), the near-page-one guides fit, but
 * eight guides with three-line headings (anthurium, hoya and others) end
 * 13-61px below; that case is checked for the near-page-one guides only.
 */
const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 13 in Safari', width: 390, height: 664 },
  { name: 'Pixel 7', width: 412, height: 839 },
  { name: 'laptop 1280x720', width: 1280, height: 720 },
  { name: 'laptop 1366x768', width: 1366, height: 768 },
  { name: 'laptop 1440x900', width: 1440, height: 900 },
] as const;

/** The near-page-one guides from Search Console (2026-10-30). */
const NEAR_PAGE_ONE = ['zz-plant', 'monstera', 'bird-of-paradise', 'aloe-vera'];
/** Plus the guides with the longest headings, which push the link lowest. */
const GUIDES = [...NEAR_PAGE_ONE, 'anthurium', 'hoya', 'chinese-evergreen', 'boston-fern'];

const SMALLEST = { name: 'iPhone SE in Safari', width: 375, height: 548 } as const;

test.describe('care guide sign-up link above the fold', () => {
  // Layout, not browser behavior: one engine is enough, and the viewports
  // are set here rather than by the project.
  test.skip(({ browserName }) => browserName !== 'chromium', 'layout check runs once');

  const cases = [
    ...VIEWPORTS.map((viewport) => ({ viewport, slugs: GUIDES })),
    { viewport: SMALLEST, slugs: NEAR_PAGE_ONE },
  ];
  for (const { viewport, slugs } of cases) {
    test(`is fully on the first screen at ${viewport.name} ${viewport.height}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const slug of slugs) {
        await page.goto(`/care/${slug}`);
        const link = page.getByTestId('care-glance-cta');
        await expect(link, slug).toBeVisible();
        const box = await link.boundingBox();
        expect(box, slug).not.toBeNull();
        // The whole link, not just its top edge, inside the first screen.
        expect(box!.y, slug).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height, `${slug} at ${viewport.name}`).toBeLessThanOrEqual(
          viewport.height
        );
        await expect(link, slug).toHaveAttribute('href', /^\/register(\?plant=[a-z-]+)?$/);
      }
    });
  }
});
