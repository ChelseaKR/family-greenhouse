import { test, expect, type Page } from '@playwright/test';
import { uiLogin } from './helpers';

/**
 * "Take photo" and "Choose photo" (NativePhotoButtons) must never overlap,
 * at iPad widths above all.
 *
 * The App Store review of 0.37.0 found the two buttons drawn over each other
 * on the plant page on a 13-inch iPad: the photo column there is 192px wide,
 * the buttons sat in a two-column grid, and a grid column shrinks below its
 * content, so each no-wrap label ran out of its half and over the other
 * button's icon. The same grid did it beside the 128px preview on Add plant.
 *
 * The buttons only exist inside the iOS and Android shells, so each test
 * first makes the page believe it is running in the iOS shell, the way the
 * native bridge does: `window.Capacitor` reports a native platform, and
 * `CapacitorCustomPlatform` keeps it saying so after `@capacitor/core` loads
 * and rebuilds that global. The native plugins are not there, and the app
 * already treats a plugin call that fails as nothing to do.
 *
 * Checked on two iPads and, as the regression guard, an iPhone; at the
 * default text size and at the largest iOS size, AX5 (312%), applied as
 * tests/e2e/largest-text.spec.ts applies it. Chromium only: text-size-adjust
 * needs its mobile emulation, and Firefox has no `isMobile`.
 */

/** AX5: 53pt body text over iOS's 17pt default. */
const LARGEST_IOS_TEXT_SCALE = 53 / 17;

const DEVICES = [
  { name: 'iPad Pro 13-inch', viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2 },
  { name: 'iPad mini', viewport: { width: 744, height: 1133 }, deviceScaleFactor: 2 },
  { name: 'iPhone 17 Pro', viewport: { width: 402, height: 874 }, deviceScaleFactor: 3 },
] as const;

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'isMobile and text-size-adjust need Chromium mobile emulation'
);

/** What the iOS shell's bridge sets up before the app's first script runs. */
async function pretendToBeTheIosShell(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  });
}

/** What useNativeTextSize does inside the iOS shell at AX5. */
async function applyLargestTextSize(page: Page) {
  const percent = `${Math.round(LARGEST_IOS_TEXT_SCALE * 100)}%`;
  await page.addInitScript((value) => {
    const apply = () => {
      document.documentElement.dataset.textSize = 'large';
      document.body.style.setProperty('-webkit-text-size-adjust', value);
      document.body.style.setProperty('text-size-adjust', value);
    };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }, percent);
}

/**
 * The page is no wider than the screen. At AX5 on an iPad, the Plants and
 * plant page headers once kept their no-wrap action buttons in one row beside
 * the title, 1007px wide on a 744px iPad mini. A mobile engine then grows the
 * layout viewport to fit, and the bottom of the page falls outside what can be
 * scrolled into view: the last plant card could not be tapped. It went unseen
 * while a memorial footer sat below the last card; with that footer moved to
 * Settings → About in the apps, the click on the card timed out.
 */
async function expectNoSidewaysOverflow(page: Page, where: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement!.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where}: the page is wider than the screen`).toBeLessThanOrEqual(
    clientWidth
  );
}

interface Findings {
  /** Rendered size of a 16px probe over 16: proves the text size applied. */
  applied: number;
  /** How many rows the two buttons take: 1 side by side, 2 stacked. */
  rows: number;
  problems: string[];
}

async function inspectPhotoButtons(page: Page): Promise<Findings> {
  const group = page.getByTestId('native-photo-buttons');
  // Two real, visible buttons, so the checks below cannot pass on nothing:
  // if the shell pretense stopped working, the web file input renders
  // instead and this fails.
  await expect(group.getByRole('button')).toHaveCount(2, { timeout: 15000 });
  for (const button of await group.getByRole('button').all()) {
    await expect(button).toBeVisible();
  }

  return group.evaluate((node) => {
    const probe = document.createElement('span');
    probe.textContent = 'probe';
    probe.style.cssText = 'font-size:16px;position:absolute;left:0;top:0;visibility:hidden';
    document.body.appendChild(probe);
    const applied = parseFloat(getComputedStyle(probe).fontSize) / 16;
    probe.remove();

    interface Box {
      left: number;
      right: number;
      top: number;
      bottom: number;
    }
    const round = (box: Box) =>
      `${Math.round(box.left)}–${Math.round(box.right)} × ${Math.round(box.top)}–${Math.round(box.bottom)}`;
    const union = (rects: DOMRect[]): Box =>
      rects.reduce<Box>(
        (all, r) => ({
          left: Math.min(all.left, r.left),
          right: Math.max(all.right, r.right),
          top: Math.min(all.top, r.top),
          bottom: Math.max(all.bottom, r.bottom),
        }),
        { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      );

    const buttons = Array.from(node.querySelectorAll('button')).map((button) => {
      // Everything the button paints: its icon, and every line of its label.
      const ink: DOMRect[] = [];
      for (const el of Array.from(button.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) ink.push(r);
      }
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim()) continue;
        range.selectNodeContents(text);
        ink.push(...Array.from(range.getClientRects()).filter((r) => r.width > 0));
      }
      const r = button.getBoundingClientRect();
      return {
        label: (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
        box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        ink: union(ink),
      };
    });

    const problems: string[] = [];
    const width = document.documentElement.clientWidth;
    const outside = (inner: Box, outer: Box) =>
      inner.left < outer.left - 1 ||
      inner.right > outer.right + 1 ||
      inner.top < outer.top - 1 ||
      inner.bottom > outer.bottom + 1;
    const intersects = (a: Box, b: Box) =>
      a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

    for (const b of buttons) {
      if (outside(b.ink, b.box)) {
        problems.push(
          `"${b.label}" paints outside its own button (${round(b.ink)} in ${round(b.box)})`
        );
      }
      if (b.box.left < -1 || b.box.right > width + 1) {
        problems.push(`"${b.label}" runs off the screen (${round(b.box)}, ${width}px wide)`);
      }
    }
    const [first, second] = buttons;
    if (
      intersects(first.box, second.box) ||
      intersects(first.ink, second.box) ||
      intersects(second.ink, first.box)
    ) {
      problems.push(
        `"${first.label}" and "${second.label}" overlap (${round(first.ink)} and ${round(second.ink)})`
      );
    }

    const rows = new Set(buttons.map((b) => Math.round(b.box.top))).size;
    return { applied, rows, problems };
  });
}

for (const device of DEVICES) {
  for (const textSize of ['default', 'AX5'] as const) {
    test.describe(`Photo buttons on ${device.name}, ${textSize} text`, () => {
      test.use({
        isMobile: true,
        hasTouch: true,
        viewport: device.viewport,
        deviceScaleFactor: device.deviceScaleFactor,
      });

      test('plant page and Add plant', async ({ page }, testInfo) => {
        await pretendToBeTheIosShell(page);
        if (textSize === 'AX5') await applyLargestTextSize(page);
        await uiLogin(page);

        await page.goto('/plants');
        const monstera = page.getByRole('link', { name: /monstera/i }).first();
        await monstera.waitFor({ state: 'visible', timeout: 15000 });
        await expectNoSidewaysOverflow(page, `${device.name}, ${textSize} text, Plants`);
        await monstera.click();
        await expect(page).toHaveURL(/\/plants\/[^/]+$/);
        // The URL changes before the plant page's chunk has loaded, and until
        // it has, the Plants list is still on screen with its own "More plant
        // actions" menu. Wait for the plant page itself, so the menu below
        // (and the overflow check) is the plant page's and not the list's.
        await expect(page.getByRole('heading', { level: 1, name: /monstera/i })).toBeVisible();
        await expectNoSidewaysOverflow(page, `${device.name}, ${textSize} text, plant page`);

        // On the plant page the two photo actions are in its "…" menu now,
        // with the rest of the plant's actions; the buttons themselves are
        // checked on Add plant, the one screen that still shows them.
        // On a phone-width plant page (and in the app's frame) the photo
        // actions are in the "…" menu with the rest of the plant's actions;
        // a wide page without the frame still shows the buttons.
        const more = page.getByLabel('More plant actions', { exact: true });
        // Phone widths get the compact plant page (this stub has no native
        // frame, so a tablet keeps the wide one).
        const inMenu = (page.viewportSize()?.width ?? 1024) < 640;
        if (inMenu) {
          await more.click();
          const menu = page.locator('details[open]');
          await expect(menu.getByRole('button', { name: 'Take photo' })).toBeVisible();
          await expect(menu.getByRole('button', { name: 'Choose photo' })).toBeVisible();
          await expectNoSidewaysOverflow(page, `${device.name}, ${textSize} text, plant page menu`);
          await page.keyboard.press('Escape');
        }

        const screens = [
          ...(inMenu ? [] : [{ screen: 'plant page', go: () => Promise.resolve() }]),
          { screen: 'Add plant', go: () => page.goto('/plants/new') },
        ];
        for (const { screen, go } of screens) {
          await go();
          const findings = await inspectPhotoButtons(page);
          await testInfo.attach(`${device.name}-${textSize}-${screen}.png`, {
            body: await page.getByTestId('native-photo-buttons').screenshot(),
            contentType: 'image/png',
          });
          const where = `${device.name}, ${textSize} text, ${screen}`;
          if (textSize === 'AX5') {
            expect(findings.applied, `${where}: the AX5 text size must apply`).toBeGreaterThan(
              LARGEST_IOS_TEXT_SCALE - 0.1
            );
            expect(findings.rows, `${where}: the buttons stack at AX5`).toBe(2);
          } else {
            expect(findings.applied, `${where}: default text size`).toBeCloseTo(1, 1);
          }
          expect(findings.problems, `${where}: photo buttons overlap or spill`).toEqual([]);
        }
      });
    });
  }
}
