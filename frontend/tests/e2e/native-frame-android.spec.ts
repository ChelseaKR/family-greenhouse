import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * The Android app's native frame (Material's top app bar and navigation bar,
 * drawn in Kotlin around the web view; NativeChromePlugin.kt), from the web's
 * side, on a real build. The same contract as native-frame.spec.ts on iOS:
 * inside the app the web hides its own chrome, reports every route, and
 * follows the native bars' events; its confirmations, choices and Add care
 * task go to the plugin. An Android build that does not register the plugin
 * keeps the web's header, drawer and dialogs, and never calls it.
 *
 * The Android shell is pretended the way the iOS one is, plus what the real
 * bridge adds for a registered plugin: a `PluginHeaders` entry and
 * `nativePromise` / `nativeCallback`. Each in-app test first checks that
 * `<html data-native-frame>` is set, so a website result can never come from
 * the pretense not taking.
 */

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'the Android shell is Chromium (the system WebView)'
);
test.use({ viewport: { width: 412, height: 915 } });

interface FrameCall {
  method: string;
  options: Record<string, unknown>;
}

const ALL_METHODS = [
  'configure',
  'update',
  'present',
  'updatePresented',
  'dismissPresented',
  'presentForm',
  'setBarTools',
];

async function pretendToBeTheAndroidShell(page: Page, { withFrame }: { withFrame: boolean }) {
  await page.addInitScript(
    ([frame, methods]) => {
      const w = window as unknown as Record<string, unknown>;
      const calls: Array<{ method: string; options: unknown }> = [];
      const listeners: Record<string, Array<(data: unknown) => void>> = {};
      w.__frame = { calls, listeners };
      w.CapacitorCustomPlatform = { name: 'android', plugins: {} };
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        PluginHeaders: frame
          ? [
              {
                name: 'NativeChrome',
                methods: [
                  { name: 'addListener' },
                  { name: 'removeListener' },
                  { name: 'removeAllListeners', rtype: 'promise' },
                  ...methods.map((name) => ({ name, rtype: 'promise' })),
                ],
              },
            ]
          : [],
        nativePromise: (plugin: string, method: string, options: unknown) => {
          if (plugin === 'NativeChrome') {
            calls.push({ method, options });
            // A sheet or alert closed without a choice.
            if (method === 'presentForm') return Promise.resolve({ values: null });
            if (method === 'present') return Promise.resolve({ id: null });
          }
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
    },
    [withFrame, ALL_METHODS] as const
  );
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

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'native-frame-android',
    householdName: 'Android House',
    plant: { name: 'Android Fern' },
  });
});

test('inside the Android app: no web header or drawer; routes reported; native events followed', async ({
  page,
}) => {
  await pretendToBeTheAndroidShell(page, { withFrame: true });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-native', 'android');
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
  await expectUpdate(page, { path: '/login', chrome: 'none' });

  await uiLogin(page, account.email, account.password);
  await expectUpdate(page, {
    path: '/dashboard',
    tab: 'home',
    chrome: 'tabs',
    title: 'Home',
    largeTitle: true,
  });
  await expect(page.getByRole('button', { name: /open sidebar/i })).toBeHidden();
  await expect(page.getByRole('navigation', { name: /main navigation/i })).toBeHidden();

  // The navigation bar's Plants tab, then a plant, then the top bar's arrow.
  await nativeEvent(page, 'tabSelect', { tab: 'plants', path: '/plants', reselect: false });
  await expect(page).toHaveURL(/\/plants$/);
  await expectUpdate(page, { path: '/plants', tab: 'plants', title: 'Plants' });
  // The Plants list's Filter and More menus and its search go to the top bar.
  await expect
    .poll(async () => (await frameCalls(page)).some((c) => c.method === 'setBarTools'))
    .toBe(true);

  await page
    .getByRole('link', { name: /Android Fern/ })
    .first()
    .click();
  await expectUpdate(page, { tab: 'plants', title: 'Android Fern', canGoBack: true });

  // Add care task opens as a native bottom sheet, not a web dialog; the sheet
  // closed without values, so nothing was written and no dialog is left.
  await page
    .locator('#care')
    .getByRole('button', { name: /^add task$/i })
    .click();
  await expect
    .poll(async () => (await frameCalls(page)).filter((c) => c.method === 'presentForm').length)
    .toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await nativeEvent(page, 'back', { path: '/plants' });
  await expect(page).toHaveURL(/\/plants$/);

  // A More row, and Sign out (the frame confirms it natively first).
  await nativeEvent(page, 'moreSelect', { id: 'help', path: '/help' });
  await expect(page).toHaveURL(/\/help$/);
  await expectUpdate(page, { path: '/help', tab: 'more' });
  await nativeEvent(page, 'moreSelect', { id: 'signOut' });
  await expect(page).toHaveURL(/\/login$/);
  await expectUpdate(page, { chrome: 'none' });
});

test('an Android build without the native frame keeps the web header and never calls it', async ({
  page,
}) => {
  await pretendToBeTheAndroidShell(page, { withFrame: false });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native', 'android');
  await expect(page.locator('html')).not.toHaveAttribute('data-native-frame', /.*/);
  await expect(page.getByRole('button', { name: /open sidebar/i })).toBeVisible();
  expect(await frameCalls(page)).toEqual([]);
});
