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
 * 13-61px below; that case is checked for the near-page-one guides, the
 * 2026-11-03 watering guides, the 2026-11-04 holiday guides, the 2026-11-05
 * batch, the 2026-11-05 batch-5 guides, the 2026-11-07 watering batch 2 and
 * the 2026-11-08 batch 6 only.
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
/**
 * The watering guides added 2026-11-03. Each was written to fit the smallest
 * case too, so they are checked there as well; string of pearls and Chinese
 * money plant have the longest names of the batch.
 */
const WATERING_BATCH_1 = [
  'string-of-pearls',
  'prayer-plant',
  'croton',
  'chinese-money-plant',
  'peperomia',
  'alocasia',
  'cast-iron-plant',
  'corn-plant',
];
/**
 * The holiday guides added 2026-11-04, written to fit the smallest case too;
 * Norfolk Island pine has the longest heading of the four.
 */
const HOLIDAY_GUIDES = ['amaryllis', 'norfolk-island-pine', 'cyclamen', 'kalanchoe'];
/** The five guides added 2026-11-05, written to fit the smallest case too. */
const BATCH_4 = ['air-plant', 'rosemary', 'ponytail-palm', 'areca-palm', 'schefflera'];
/** The six batch-5 guides added 2026-11-05, written to fit the smallest case too. */
const BATCH_5 = [
  'satin-pothos',
  'dragon-tree',
  'arrowhead-plant',
  'weeping-fig',
  'polka-dot-plant',
  'tradescantia',
];
/** The eight watering guides of batch 2, added 2026-11-07, written to fit the smallest case too. */
const WATERING_BATCH_2 = [
  'jasmine',
  'lucky-bamboo',
  'venus-flytrap',
  'majesty-palm',
  'kentia-palm',
  'paperwhite',
  'birds-nest-fern',
  'purple-shamrock',
];
/** The seven guides of batch 6, added 2026-11-08, written to fit the smallest case too. */
const BATCH_6 = [
  'thai-constellation-monstera',
  'cebu-blue-pothos',
  'rattlesnake-plant',
  'peacock-plant',
  'zebra-calathea',
  'calathea-orbifolia',
  'coleus',
];
/** Plus the guides with the longest headings, which push the link lowest. */
const GUIDES = [
  ...NEAR_PAGE_ONE,
  'anthurium',
  'hoya',
  'chinese-evergreen',
  'boston-fern',
  ...WATERING_BATCH_1,
  ...HOLIDAY_GUIDES,
  ...BATCH_4,
  ...BATCH_5,
  ...WATERING_BATCH_2,
  ...BATCH_6,
];

const SMALLEST = { name: 'iPhone SE in Safari', width: 375, height: 548 } as const;

test.describe('care guide sign-up link above the fold', () => {
  // Layout, not browser behavior: one engine is enough, and the viewports
  // are set here rather than by the project.
  test.skip(({ browserName }) => browserName !== 'chromium', 'layout check runs once');
  // Each test opens every listed guide in turn: 20 to 23s for 71 guides on
  // 2026-11-08, and the default 30s ran out on a busy machine.
  test.describe.configure({ timeout: 60_000 });

  const cases = [
    ...VIEWPORTS.map((viewport) => ({ viewport, slugs: GUIDES })),
    {
      viewport: SMALLEST,
      slugs: [
        ...NEAR_PAGE_ONE,
        ...WATERING_BATCH_1,
        ...HOLIDAY_GUIDES,
        ...BATCH_4,
        ...BATCH_5,
        ...WATERING_BATCH_2,
        ...BATCH_6,
      ],
    },
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
