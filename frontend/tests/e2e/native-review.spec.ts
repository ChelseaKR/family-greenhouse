import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

/**
 * The iOS app's rating ask and Rate row (ADR 0036), from the web's side, on a
 * real production build.
 *
 * The iOS shell is pretended as in native-intro.spec.ts: `PluginHeaders`
 * lists NativeReview (and App, for the version) so the plugin's calls reach
 * a pretend bridge that records them. The fallback test pretends the shell
 * without NativeReview, which is an iOS build from before the plugin: it
 * must record nothing, ask nothing and load nothing.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 390, height: 844 } });

const STATE_KEY = 'fg.reviewPrompt';
const REVIEW_URL = 'https://apps.apple.com/app/id6812185914?action=write-review';
/** The plugin's own chunk (services/nativeReviewPlugin.ts), by Vite's name for it. */
const REVIEW_CHUNK = /\/assets\/nativeReviewPlugin-[\w-]+\.js$/;

interface BridgeCall {
  plugin: string;
  method: string;
}

async function pretendToBeTheIosShell(
  page: Page,
  opts: { review: boolean; seed?: Record<string, unknown> }
) {
  await page.addInitScript(
    ({ review, seed, key }) => {
      const w = window as unknown as Record<string, unknown>;
      const calls: unknown[] = [];
      w.__bridgeCalls = calls;
      // Seeded once: a reload keeps whatever the page wrote since.
      if (seed && localStorage.getItem(key) === null) {
        localStorage.setItem(key, JSON.stringify(seed));
      }
      w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        // Every build links @capacitor/app; only a build with the plugin
        // lists NativeReview.
        PluginHeaders: [
          ...(review
            ? [{ name: 'NativeReview', methods: [{ name: 'requestReview', rtype: 'promise' }] }]
            : []),
          {
            name: 'App',
            methods: [
              { name: 'getInfo', rtype: 'promise' },
              { name: 'addListener', rtype: 'callback' },
              { name: 'removeAllListeners', rtype: 'promise' },
            ],
          },
        ],
        nativePromise: (plugin: string, method: string) => {
          calls.push({ plugin, method });
          if (plugin === 'NativeReview' && method === 'requestReview') {
            return Promise.resolve({ requested: true });
          }
          if (plugin === 'App' && method === 'getInfo') {
            return Promise.resolve({
              name: 'Family Greenhouse',
              id: 'net.familygreenhouse.app',
              version: '0.43.0',
              build: '4300',
            });
          }
          return Promise.resolve();
        },
        nativeCallback: () => 'callback',
      };
    },
    { review: opts.review, seed: opts.seed, key: STATE_KEY }
  );
}

function watchReviewChunk(page: Page): string[] {
  const loaded: string[] = [];
  page.on('request', (r) => {
    if (REVIEW_CHUNK.test(new URL(r.url()).pathname)) loaded.push(r.url());
  });
  return loaded;
}

function bridgeCalls(page: Page): Promise<BridgeCall[]> {
  return page.evaluate(() => (window as unknown as { __bridgeCalls: BridgeCall[] }).__bridgeCalls);
}

async function reviewRequests(page: Page): Promise<number> {
  return (await bridgeCalls(page)).filter(
    (c) => c.plugin === 'NativeReview' && c.method === 'requestReview'
  ).length;
}

async function storedState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }, STATE_KEY);
}

/** Water the plant from the Plants list and let the Undo window pass. */
async function waterAndLetItLand(page: Page, plant: string) {
  const completions: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/tasks\/[^/]+\/complete$/.test(req.url())) {
      completions.push(req.url());
    }
  });
  await page.goto('/plants');
  await page.getByRole('button', { name: `Water ${plant}` }).click();
  await expect.poll(() => completions.length, { timeout: 15000 }).toBe(1);
  await expect(page.getByText('Task completed')).toBeVisible({ timeout: 15000 });
}

test.describe('inside the iOS app, with NativeReview', () => {
  test('the third completion, in a later launch, asks StoreKit once and records it', async ({
    page,
  }) => {
    const acct = await provisionAccount({
      emailPrefix: 'native-review-ask',
      plant: { name: 'Review Fern' },
      waterTask: { frequency: 7 },
    });
    // Two completions already counted, the first of them in an earlier launch.
    await pretendToBeTheIosShell(page, {
      review: true,
      seed: { completions: 2, firstLaunch: 'an-earlier-launch' },
    });
    const chunk = watchReviewChunk(page);
    // The control: only the shells send a signed-out `/` to sign-in, so this
    // is the app, not the website.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
    expect(await storedState(page)).toMatchObject({ completions: 2 });
    await uiLogin(page, acct.email, acct.password);

    await waterAndLetItLand(page, 'Review Fern');
    await expect.poll(() => reviewRequests(page), { timeout: 15000 }).toBe(1);
    expect(await storedState(page)).toMatchObject({
      completions: 0,
      lastAskedVersion: '0.43.0',
    });
    expect(chunk.length).toBeGreaterThan(0);
    // Asked once, not again a moment later.
    await page.waitForTimeout(2500);
    expect(await reviewRequests(page)).toBe(1);
  });

  test('a first completion only counts: no ask, and the plugin chunk is not loaded', async ({
    page,
  }) => {
    const acct = await provisionAccount({
      emailPrefix: 'native-review-count',
      plant: { name: 'Count Fern' },
      waterTask: { frequency: 7 },
    });
    await pretendToBeTheIosShell(page, { review: true });
    const chunk = watchReviewChunk(page);
    await uiLogin(page, acct.email, acct.password);
    await waterAndLetItLand(page, 'Count Fern');
    await expect
      .poll(() => storedState(page), { timeout: 15000 })
      .toMatchObject({ completions: 1 });
    await page.waitForTimeout(2500);
    expect(await reviewRequests(page)).toBe(0);
    expect(chunk).toEqual([]);
  });

  test('Settings → About has the Rate row, linking to the App Store review form', async ({
    page,
  }) => {
    await pretendToBeTheIosShell(page, { review: true });
    await uiLogin(page);
    await page.goto('/settings?section=about');
    const row = page.getByRole('link', { name: /Rate Family Greenhouse/ });
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveAttribute('href', REVIEW_URL);
    // App Review reads this screen: nothing about plans or prices on it.
    await expect(page.locator('#settings-panel')).not.toContainText(/\$\s*\d|trial|upgrade/i);
  });
});

test.describe('inside an iOS build without NativeReview', () => {
  test('a completion records nothing, asks nothing and loads nothing', async ({ page }) => {
    const acct = await provisionAccount({
      emailPrefix: 'native-review-fallback',
      plant: { name: 'Fallback Fern' },
      waterTask: { frequency: 7 },
    });
    const seed = { completions: 2, firstLaunch: 'an-earlier-launch' };
    await pretendToBeTheIosShell(page, { review: false, seed });
    const chunk = watchReviewChunk(page);
    // The control, as above: this is the app.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
    await uiLogin(page, acct.email, acct.password);
    await waterAndLetItLand(page, 'Fallback Fern');
    await page.waitForTimeout(2500);
    expect(await reviewRequests(page)).toBe(0);
    expect(await storedState(page)).toEqual(seed);
    expect(chunk).toEqual([]);
  });
});

test.describe('on the website', () => {
  test('there is no Rate row and no About section', async ({ page }) => {
    await uiLogin(page);
    await page.goto('/settings?section=about');
    await expect(page.locator('#settings-panel')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`a[href="${REVIEW_URL}"]`)).toHaveCount(0);
  });
});
