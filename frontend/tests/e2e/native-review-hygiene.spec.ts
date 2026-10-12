import { test, expect, type Page } from '@playwright/test';
import { uiLogin } from './helpers';

/**
 * App Review hygiene (Guideline 3.1.1), end to end in a real browser build.
 *
 * Inside the iOS app there must be no path toward buying anywhere but In-App
 * Purchase: /pricing and /gift open Settings → Plan status, and no footer or
 * header links to either. The memorial line lives only on Settings → About
 * there. The website, which takes real payments, keeps every one of those
 * paths and the line on every page; the second describe holds that.
 *
 * The iOS shell is pretended exactly as tests/e2e/native-photo-buttons.spec.ts
 * does it. Every "inside the app" test first proves the pretense took (a
 * signed-out `/` goes to sign-in only inside the shells), so an absence below
 * can never pass because the page was simply the website.
 */

const MEMORIAL = 'In loving memory of my mom, Joyce — who taught us to keep growing.';

test.skip(({ browserName }) => browserName !== 'chromium', 'one engine is enough for routing');
test.use({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });

async function pretendToBeTheIosShell(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  });
}

async function purchaseLinkCount(page: Page) {
  return page.locator('a[href="/pricing"], a[href="/gift"], a[href^="/gift?"]').count();
}

test.describe('inside the iOS app', () => {
  test.beforeEach(async ({ page }) => {
    await pretendToBeTheIosShell(page);
    // The control: only the shells send a signed-out `/` to sign-in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
  });

  test('/pricing and /gift open Settings → Plan status', async ({ page }) => {
    await uiLogin(page);
    for (const path of ['/pricing', '/gift']) {
      await page.goto(path);
      await expect(page, `${path} inside the app`).toHaveURL(/\/settings\/billing$/, {
        timeout: 15000,
      });
      await expect(page.getByText("Plan changes aren't available in the app.")).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/\$\s*\d/);
      await expect(page.locator('body')).not.toContainText(/on the web|web browser/i);
      expect(await purchaseLinkCount(page), `${path}: links toward buying`).toBe(0);
    }
  });

  test('the public footer and header offer neither plans nor gifts, and no memorial', async ({
    page,
  }) => {
    await page.goto('/help');
    await expect(page.locator('footer nav')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('footer a[href="/legal/privacy"]')).toHaveCount(1);
    expect(await purchaseLinkCount(page)).toBe(0);
    await expect(page.getByText(MEMORIAL)).toHaveCount(0);
  });

  test('the memorial line is on Settings → About and on no other screen', async ({ page }) => {
    await uiLogin(page);
    await expect(page.locator('#main-content h1').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(MEMORIAL)).toHaveCount(0);
    await page.goto('/settings?section=about');
    await expect(page.getByText(MEMORIAL)).toBeVisible({ timeout: 15000 });
  });
});

test.describe('inside the iOS app, the signed-out intro', () => {
  // The intro (ADR 0035) is the app's first screen for a new install, which
  // is the screen App Review sees first. Every word it can show, in English
  // and Spanish, says nothing about plans, prices, gifts, trials or buying.
  // The shell is pretended with the NativeIntro plugin listed, and the
  // pretend bridge records what the web asked it to show.
  async function pretendWithTheIntro(page: Page, language: 'en' | 'es') {
    await page.addInitScript((lng) => {
      localStorage.setItem('i18nextLng', lng);
      const w = window as unknown as Record<string, unknown>;
      const shown: unknown[] = [];
      w.__introShown = shown;
      w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        PluginHeaders: [
          {
            name: 'NativeIntro',
            methods: [
              { name: 'present', rtype: 'promise' },
              { name: 'dismiss', rtype: 'promise' },
            ],
          },
        ],
        nativePromise: (plugin: string, method: string, options: unknown) => {
          if (plugin === 'NativeIntro' && method === 'present') {
            shown.push(options);
            return Promise.resolve({ choice: null });
          }
          return Promise.resolve();
        },
        nativeCallback: () => 'callback',
      };
    }, language);
  }

  for (const language of ['en', 'es'] as const) {
    test(`its words (${language}) offer no plans, prices, gifts, trials or purchases`, async ({
      page,
    }) => {
      await pretendWithTheIntro(page, language);
      await page.goto('/');
      await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as { __introShown: unknown[] }).__introShown.length
            ),
          {
            timeout: 15000,
          }
        )
        .toBe(1);
      const request = await page.evaluate(
        () =>
          (window as unknown as { __introShown: Array<Record<string, unknown>> }).__introShown[0]
      );
      // The control: the intro was really asked for, with its pages and doors.
      expect((request.pages as unknown[]).length).toBe(4);
      expect(request.signIn).toBeTruthy();
      const words = JSON.stringify(request);
      expect(words).not.toMatch(/\$\s*\d|€\s*\d/);
      expect(words).not.toMatch(
        /\b(plans?|pric\w*|free|gratis|gift\w*|regal\w*|trial|prueba|purchas\w*|buy\w*|compr\w*|subscri\w*|suscri\w*|seedling|upgrade|mejora)\b/i
      );
      expect(words).not.toMatch(/on the web|web browser|en la web|navegador/i);
    });
  }
});

test.describe('on the website (unchanged)', () => {
  test('the control: a signed-out `/` is the landing page, not sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login$/);
  });

  test('/pricing and /gift are their own pages', async ({ page }) => {
    for (const path of ['/pricing', '/gift']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 });
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
  });

  test('the footer links to plans and gifts and closes with the memorial line', async ({
    page,
  }) => {
    await page.goto('/help');
    await expect(page.locator('footer a[href="/pricing"]')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('footer a[href="/gift"]')).toHaveCount(1);
    await expect(page.getByText(MEMORIAL)).toBeVisible();
  });

  test('signed in, every page closes with the memorial line', async ({ page }) => {
    await uiLogin(page);
    await expect(page.getByText(MEMORIAL)).toBeVisible({ timeout: 15000 });
  });
});
