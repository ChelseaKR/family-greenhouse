import { test, expect, type Page, type TestInfo } from '@playwright/test';

/**
 * The main screens at the largest iOS text size (#845 follow-up).
 *
 * Inside the iOS app, `useNativeTextSize` hands the size chosen in Settings →
 * Accessibility → Display & Text Size to the WebView as the body's
 * `-webkit-text-size-adjust`, with no ceiling since the 200% cap was removed
 * (owner decision, 2026-09-18). The largest setting, AX5, is 53pt body text
 * over the 17pt default: 312%. Text-size-adjust grows TEXT only — a
 * `h-9` box stays 36px — which is exactly how a fixed-height control ends up
 * clipping its own label, so this is what the layout has to hold at.
 *
 * Chromium with mobile emulation (`isMobile`) applies text-size-adjust the
 * way iOS does (measured: a 16px paragraph renders at 49.92px while a 2rem
 * box stays 32px); desktop Chromium, Firefox and WebKit ignore it. So this
 * spec runs in the chromium project only, with `isMobile` on, at an iPhone
 * 17 Pro viewport — and first proves the scale really applied, so a browser
 * that ignored it could not pass the checks below vacuously.
 *
 * On every screen: the page never scrolls sideways, no text runs off the
 * screen, no text spills out of its own box (sideways or down) over its
 * neighbors, no neighbor squeezes a word into pieces, and no element clips
 * its own text with overflow:hidden. A screenshot of each
 * screen is attached to the report. (Not full-page: Chromium drops the text
 * adjustment while it lays out a full-page capture.)
 */

/** AX5: 53pt body text over iOS's 17pt default. */
const LARGEST_IOS_TEXT_SCALE = 53 / 17;
const SCALE_PERCENT = `${Math.round(LARGEST_IOS_TEXT_SCALE * 100)}%`;

test.use({
  isMobile: true,
  hasTouch: true,
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
});

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'text-size-adjust needs Chromium mobile emulation');
  // What useNativeTextSize does inside the iOS shell at AX5, on every page
  // load: TextZoom.set's body text-size-adjust, and markTextScale's
  // <html data-text-size="large">, which switches on the large-text layout.
  // Both wait for <body>: an init script runs before the parser has made
  // <html>, and touching documentElement then throws, which silently left
  // the page at 100%.
  await page.addInitScript((percent) => {
    const apply = () => {
      document.documentElement.dataset.textSize = 'large';
      document.body.style.setProperty('-webkit-text-size-adjust', percent);
      document.body.style.setProperty('text-size-adjust', percent);
    };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }, SCALE_PERCENT);
});

interface Findings {
  applied: number;
  sideways: number;
  problems: string[];
}

async function inspect(page: Page): Promise<Findings> {
  return page.evaluate(() => {
    // The scale really applied: a 16px probe must render near 50px.
    const probe = document.createElement('span');
    probe.textContent = 'probe';
    probe.style.cssText = 'font-size:16px;position:absolute;left:0;top:0;visibility:hidden';
    document.body.appendChild(probe);
    const applied = parseFloat(getComputedStyle(probe).fontSize) / 16;
    probe.remove();

    const width = document.documentElement.clientWidth;
    const problems: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // A closed <details> lays its content out without painting it.
      if (el.closest('details:not([open])') && !el.closest('summary')) continue;
      const box = el.getBoundingClientRect();
      // Screen-reader-only text is 1px on purpose.
      if (box.width <= 1 || box.height <= 1) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const label = `${el.tagName.toLowerCase()} "${text.slice(0, 40)}"`;
      const clipsX =
        ['hidden', 'clip'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const clipsY =
        ['hidden', 'clip'].includes(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (clipsX || clipsY) problems.push(`${label} clips its text`);
      const ownText = Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
      );
      // Text wider than its own box spills over whatever sits next to it: a
      // button label over its neighbor, a heading under an action. Text
      // taller than a fixed-height box runs down over the row below. (A
      // glyph or two past a `leading-none` line box is not that, so the
      // vertical check allows a quarter of the font size.)
      const textBox = ownText || ['BUTTON', 'A', 'LABEL', 'SUMMARY'].includes(el.tagName);
      if (textBox && style.display !== 'inline') {
        if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) {
          problems.push(`${label} spills out of its box (${el.scrollWidth} > ${el.clientWidth}px)`);
        }
        if (
          style.overflowY === 'visible' &&
          el.scrollHeight - el.clientHeight > parseFloat(style.fontSize) / 4
        ) {
          problems.push(
            `${label} spills below its box (${el.scrollHeight} > ${el.clientHeight}px)`
          );
        }
      }
      if (ownText && (box.right > width + 1 || box.left < -1)) {
        problems.push(
          `${label} runs off the screen (${Math.round(box.left)}–${Math.round(box.right)}px)`
        );
      }
    }

    // A word broken across lines inside a box that shares its row with a
    // neighbor, although the whole row had room for it: the neighbor
    // squeezed it ("somethi / ng"). A word wider than the row itself, like
    // a long plant name in a 94px heading, has to break and is not flagged.
    const rowWidth = (from: Element): number => {
      for (let item: Element | null = from; item?.parentElement; item = item.parentElement) {
        const row: HTMLElement = item.parentElement;
        const rowStyle = getComputedStyle(row);
        if (!/flex|grid/.test(rowStyle.display)) continue;
        const box = item.getBoundingClientRect();
        const shared = Array.from(row.children).some((sibling) => {
          if (sibling === item) return false;
          const position = getComputedStyle(sibling).position;
          if (position === 'absolute' || position === 'fixed') return false;
          const other = sibling.getBoundingClientRect();
          return (
            other.width > 0 &&
            other.height > 0 &&
            other.top < box.bottom - 1 &&
            other.bottom > box.top + 1
          );
        });
        if (!shared) continue;
        return (
          row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight)
        );
      }
      return 0;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('.sr-only')) continue;
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') continue;
      if (parent.closest('details:not([open])') && !parent.closest('summary')) continue;
      for (const word of (node.textContent ?? '').matchAll(/[\p{L}\p{N}'’]{4,}/gu)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const pieces = Array.from(range.getClientRects()).filter((r) => r.width > 0);
        if (new Set(pieces.map((r) => Math.round(r.top))).size < 2) continue;
        const wordWidth = pieces.reduce((sum, r) => sum + r.width, 0);
        const room = rowWidth(parent);
        if (wordWidth < room - 1) {
          problems.push(
            `"${word[0]}" is squeezed apart by a neighbor (${Math.round(wordWidth)}px word, ${Math.round(room)}px row)`
          );
        }
      }
    }

    return {
      applied,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      problems,
    };
  });
}

async function expectReadable(page: Page, testInfo: TestInfo, screen: string) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 15000 });
  const findings = await inspect(page);
  await testInfo.attach(`${screen}-ax5.png`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect(findings.applied, `${screen}: the ${SCALE_PERCENT} text size must apply`).toBeGreaterThan(
    LARGEST_IOS_TEXT_SCALE - 0.1
  );
  expect(findings.sideways, `${screen}: the page must not scroll sideways`).toBeLessThanOrEqual(0);
  expect(findings.problems, `${screen}: text clipped or off screen`).toEqual([]);
}

/**
 * Sign in through the form, like `uiLogin`, with selectors that hold in
 * either language.
 */
async function signIn(page: Page) {
  await page.goto('/login');
  const email = page.locator('input[type="email"]');
  await email.waitFor({ state: 'visible', timeout: 15000 });
  await email.fill('test@example.com');
  await page.locator('input[type="password"]').fill('password123');
  await page.locator('form button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
}

// Spanish too: its labels run longer, and at 312% a few letters decide
// whether two buttons still fit side by side.
for (const locale of ['en-US', 'es-ES'] as const) {
  test.describe(`Main screens at the largest iOS text size (${SCALE_PERCENT}, ${locale})`, () => {
    test.use({ locale });

    test('sign-in', async ({ page }, testInfo) => {
      await page.goto('/login');
      await expectReadable(page, testInfo, `sign-in-${locale}`);
    });

    test('plant list, plant detail, tasks and settings', async ({ page }, testInfo) => {
      await signIn(page);

      await page.goto('/plants');
      await expectReadable(page, testInfo, `plants-${locale}`);

      const monstera = page.getByRole('link', { name: /monstera/i }).first();
      await monstera.waitFor({ state: 'visible', timeout: 15000 });
      await monstera.click();
      await expect(page).toHaveURL(/\/plants\/[^/]+$/);
      await expectReadable(page, testInfo, `plant-detail-${locale}`);

      await page.goto('/tasks');
      await expectReadable(page, testInfo, `tasks-${locale}`);

      await page.goto('/settings');
      await expectReadable(page, testInfo, `settings-${locale}`);
    });
  });
}
