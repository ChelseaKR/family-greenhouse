import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * The iOS app's native frame (Apple's tab bar and navigation bar, drawn by
 * Swift around the web view), from the web's side, on a real build.
 *
 * Inside the app, the web must hide its own chrome (header, hamburger,
 * drawer, sidebar, "Back to …" links) and report every route to the
 * NativeChrome plugin; taps on the native bars arrive as plugin events and
 * must move the web router. On the website, and in an iOS build without the
 * plugin, none of it may happen.
 *
 * The iOS shell is pretended as in native-shell-polish.spec.ts, plus what the
 * real bridge adds for a registered plugin: a `PluginHeaders` entry, and
 * `nativePromise` / `nativeCallback`, the two calls every plugin method goes
 * through. The stub records each NativeChrome call and keeps the event
 * listeners, so a test can play the part of a native tap. Each in-app test
 * first checks that `<html data-native-frame>` is set, so a "website" result
 * can never come from the pretense not taking.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 402, height: 874 } });

interface FrameCall {
  method: string;
  options: Record<string, unknown>;
}

async function pretendToBeTheIosShell(page: Page, { withFrame }: { withFrame: boolean }) {
  await page.addInitScript((frame) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: Array<{ method: string; options: unknown }> = [];
    const listeners: Record<string, Array<(data: unknown) => void>> = {};
    w.__frame = { calls, listeners };
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    w.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      PluginHeaders: frame
        ? [
            {
              name: 'NativeChrome',
              methods: [
                { name: 'addListener' },
                { name: 'removeListener' },
                { name: 'removeAllListeners', rtype: 'promise' },
                { name: 'configure', rtype: 'promise' },
                { name: 'update', rtype: 'promise' },
              ],
            },
          ]
        : [],
      nativePromise: (plugin: string, method: string, options: unknown) => {
        if (plugin === 'NativeChrome') calls.push({ method, options });
        return Promise.resolve();
      },
      nativeCallback: (
        plugin: string,
        method: string,
        options: { eventName?: string },
        callback: (data: unknown) => void
      ) => {
        if (plugin === 'NativeChrome' && method === 'addListener' && options.eventName) {
          (listeners[options.eventName] ??= []).push(callback);
        }
        return 'callback';
      },
    };
  }, withFrame);
}

async function frameCalls(page: Page): Promise<FrameCall[]> {
  return page.evaluate(
    () => (window as unknown as { __frame: { calls: FrameCall[] } }).__frame.calls
  );
}

async function lastUpdate(page: Page): Promise<Record<string, unknown> | undefined> {
  const calls = await frameCalls(page);
  return calls.filter((c) => c.method === 'update').at(-1)?.options;
}

/** What a tap on the native bars does: fire the plugin event. */
async function nativeEvent(page: Page, eventName: string, data: Record<string, unknown>) {
  await page.evaluate(
    ([name, payload]) => {
      const frame = (
        window as unknown as {
          __frame: { listeners: Record<string, Array<(d: unknown) => void>> };
        }
      ).__frame;
      for (const listener of frame.listeners[name] ?? []) listener(payload);
    },
    [eventName, data] as const
  );
}

async function expectUpdate(page: Page, expected: Record<string, unknown>) {
  await expect.poll(async () => lastUpdate(page), { timeout: 15000 }).toMatchObject(expected);
}

const MEMORIAL = 'In loving memory of my mom, Joyce — who taught us to keep growing.';

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'native-frame',
    householdName: 'Frame House',
    plant: { name: 'Frame Fern' },
  });
});

test('inside the iOS app: no web header, drawer or back links; every route reported', async ({
  page,
}) => {
  await pretendToBeTheIosShell(page, { withFrame: true });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');

  // Sign-in: no bars at all.
  await expectUpdate(page, { path: '/login', chrome: 'none' });

  await uiLogin(page, account.email, account.password);

  // Home: a tab root, with a large title named after the tab. The page's
  // greeting h1 says something else, so it stays on screen.
  await expectUpdate(page, {
    path: '/dashboard',
    tab: 'home',
    chrome: 'tabs',
    title: 'Home',
    largeTitle: true,
    canGoBack: false,
  });
  await expect(page.locator('#main-content h1').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /open sidebar/i })).toBeHidden();
  await expect(page.getByRole('navigation', { name: /main navigation/i })).toBeHidden();

  // The plugin was configured with the five tabs and a More list that keeps
  // every drawer destination and Sign out.
  const configure = (await frameCalls(page)).filter((c) => c.method === 'configure').at(-1)
    ?.options as {
    tabs: Array<{ id: string }>;
    moreSections: Array<{ items: Array<{ id: string }> }>;
  };
  expect(configure.tabs.map((t) => t.id)).toEqual(['home', 'plants', 'tasks', 'household', 'more']);
  const moreIds = configure.moreSections.flatMap((s) => s.items.map((i) => i.id));
  for (const id of ['today', 'chat', 'analytics', 'settings', 'help', 'about', 'signOut']) {
    expect(moreIds).toContain(id);
  }

  // A tab tap on the native bar: the web follows.
  await nativeEvent(page, 'tabSelect', { tab: 'plants', path: '/plants', reselect: false });
  await expect(page).toHaveURL(/\/plants$/);
  await expectUpdate(page, {
    path: '/plants',
    tab: 'plants',
    title: 'Plants',
    largeTitle: true,
    rightButton: { id: 'addPlant', symbol: 'plus' },
  });
  // The bar says "Plants", so the page's own "Plants" h1 is hidden from
  // sight, and still there for VoiceOver and for the launch screen.
  const plantsHeading = page.getByRole('heading', { level: 1, name: 'Plants' });
  await expect(plantsHeading).toHaveAttribute('data-native-title', 'bar');
  const box = await plantsHeading.boundingBox();
  expect(box && box.width <= 1 && box.height <= 1).toBe(true);

  // A plant: pushed, with its name as the title and a way back.
  await page
    .getByRole('link', { name: /Frame Fern/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/plants\/[^/]+$/);
  await expectUpdate(page, {
    tab: 'plants',
    title: 'Frame Fern',
    canGoBack: true,
    largeTitle: false,
  });
  await expect(page.getByRole('link', { name: /back to plants/i })).toBeHidden();

  // The native back button.
  await nativeEvent(page, 'back', { path: '/plants' });
  await expect(page).toHaveURL(/\/plants$/);

  // The bar's "+" button.
  await nativeEvent(page, 'rightButton', { id: 'addPlant' });
  await expect(page).toHaveURL(/\/plants\/new$/);
  await expect(page.getByRole('link', { name: /back to plants/i })).toBeHidden();

  // A More row.
  await nativeEvent(page, 'moreSelect', { id: 'settings', path: '/settings' });
  await expect(page).toHaveURL(/\/settings$/);
  await expectUpdate(page, { path: '/settings', tab: 'more', canGoBack: true });

  // More's About row opens the real About section (PR #903): the memorial
  // line is there, and on no app screen's footer.
  await nativeEvent(page, 'moreSelect', { id: 'about', path: '/settings?section=about' });
  await expect(page).toHaveURL(/\/settings\?section=about$/);
  await expectUpdate(page, { path: '/settings?section=about', tab: 'more', canGoBack: true });
  await expect(page.getByText(MEMORIAL)).toHaveCount(1);

  // In the app, /pricing is Settings -> Plan status (PR #903), in the More tab.
  await page.evaluate(() => {
    window.history.pushState(null, '', '/pricing');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expectUpdate(page, { path: '/settings/billing', tab: 'more' });

  // Help sits outside the app layout; its site header and footer go too.
  await nativeEvent(page, 'moreSelect', { id: 'help', path: '/help' });
  await expect(page).toHaveURL(/\/help$/);
  await expectUpdate(page, { path: '/help', tab: 'more' });
  await expect(page.getByRole('navigation', { name: /^site$/i })).toBeHidden();
  await expect(page.getByRole('link', { name: /back to your dashboard/i })).toBeHidden();
  await expect(page.locator('footer')).toBeHidden();

  // Sign out from More: the bars go with the session.
  await nativeEvent(page, 'moreSelect', { id: 'signOut' });
  await expect(page).toHaveURL(/\/login$/);
  await expectUpdate(page, { chrome: 'none' });
});

test('on the website: the header, drawer and back links are all there, nothing reported', async ({
  page,
}) => {
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).not.toHaveAttribute('data-native-frame', /.*/);
  await expect(page.getByRole('button', { name: /open sidebar/i })).toBeVisible();
  await page.goto('/plants');
  await expect(page.getByRole('heading', { level: 1, name: 'Plants' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Plants' })).not.toHaveAttribute(
    'data-native-title',
    /.*/
  );
  await page
    .getByRole('link', { name: /Frame Fern/ })
    .first()
    .click();
  await expect(page.getByRole('link', { name: /back to plants/i })).toBeVisible();
  await page.goto('/help');
  await expect(page.getByRole('link', { name: /back to your dashboard/i })).toBeVisible();
  await expect(page.locator('footer').first()).toBeVisible();
});

test('an iOS build without the native frame keeps the web header', async ({ page }) => {
  await pretendToBeTheIosShell(page, { withFrame: false });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native', 'ios');
  await expect(page.locator('html')).not.toHaveAttribute('data-native-frame', /.*/);
  await expect(page.getByRole('button', { name: /open sidebar/i })).toBeVisible();
  expect(await frameCalls(page)).toEqual([]);
});
