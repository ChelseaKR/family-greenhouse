import { test, expect, type Page } from '@playwright/test';

/**
 * Native-only CSS (index.css, "Inside the native shells"), from both sides.
 *
 * Inside the iOS app: body text in the system font with the headings on the
 * brand faces, no tap highlight, no text selection on chrome (buttons, the
 * navigation) while every form field stays selectable, and no link callout.
 * On the website none of it applies: the same elements compute exactly as
 * before.
 *
 * The iOS shell is pretended as in tests/e2e/native-photo-buttons.spec.ts.
 * Each native test first checks that `<html data-native="ios">` is set, so a
 * "website" result can never come from the pretense not taking.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the -webkit- properties under test exist in Chromium and WebKit only'
);
test.use({ viewport: { width: 402, height: 874 } });

async function pretendToBeTheIosShell(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  });
}

interface Computed {
  native: string | null;
  bodyFont: string;
  headingFont: string;
  serifHeadingFont: string | null;
  tapHighlight: string;
  buttonSelect: string;
  inputSelect: string;
  paragraphSelect: string;
  linkCallout: string | null;
}

async function readComputed(page: Page): Promise<Computed> {
  await page.goto('/login');
  await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 15000 });
  return page.evaluate(() => {
    const css = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const style = (el: Element | null, prop: string) => css(el)?.getPropertyValue(prop) ?? '';
    // A heading with no font utility, made here so the check does not depend
    // on which headings this screen happens to carry.
    const plainHeading = document.createElement('h2');
    plainHeading.textContent = 'probe';
    document.body.appendChild(plainHeading);
    const serifHeading = document.querySelector('h1.font-serif, h2.font-serif, h1 .font-serif');
    const button = document.querySelector('button[type="submit"]');
    const input = document.querySelector('input[type="email"], input[name="email"]');
    const paragraph = document.querySelector('main p, form p, p');
    const link = document.querySelector('a[href]');
    const out = {
      native: document.documentElement.getAttribute('data-native'),
      bodyFont: style(document.body, 'font-family'),
      headingFont: style(plainHeading, 'font-family'),
      serifHeadingFont: serifHeading ? style(serifHeading, 'font-family') : null,
      tapHighlight: style(document.documentElement, '-webkit-tap-highlight-color'),
      buttonSelect: css(button)?.userSelect || style(button, '-webkit-user-select'),
      inputSelect: css(input)?.userSelect || style(input, '-webkit-user-select'),
      paragraphSelect: css(paragraph)?.userSelect || style(paragraph, '-webkit-user-select'),
      linkCallout:
        (css(link) as unknown as Record<string, string> | null)?.webkitTouchCallout ?? null,
    };
    plainHeading.remove();
    return out;
  });
}

test('inside the iOS app: system body font, brand headings, no tap flash, chrome not selectable', async ({
  page,
  browserName,
}) => {
  await pretendToBeTheIosShell(page);
  const c = await readComputed(page);

  expect(c.native, 'the native marker must be set, or nothing below means anything').toBe('ios');
  expect(c.bodyFont).toMatch(/^-apple-system/);
  expect(c.headingFont).toMatch(/^"?Instrument Sans Variable/);
  if (c.serifHeadingFont !== null) expect(c.serifHeadingFont).toMatch(/^"?Bitter Variable/);
  expect(c.tapHighlight).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(c.buttonSelect).toBe('none');
  expect(c.inputSelect).toBe('text');
  // Content stays selectable: only chrome opts out.
  expect(c.paragraphSelect).not.toBe('none');
  if (browserName === 'webkit' && c.linkCallout !== null) expect(c.linkCallout).toBe('none');
});

test('on the website: none of it applies', async ({ page, browserName }) => {
  const c = await readComputed(page);

  expect(c.native).toBeNull();
  expect(c.bodyFont).toMatch(/^"?Instrument Sans Variable/);
  expect(c.headingFont).toMatch(/^"?Instrument Sans Variable/);
  // No tap-highlight assertion here: desktop Chromium and WebKit already
  // compute the website's default as transparent, so it cannot tell the two
  // apart. The native test above asserts the value the app sets.
  expect(c.buttonSelect).not.toBe('none');
  expect(c.inputSelect).not.toBe('none');
  if (browserName === 'webkit' && c.linkCallout !== null) expect(c.linkCallout).not.toBe('none');
});
