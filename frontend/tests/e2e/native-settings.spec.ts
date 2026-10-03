import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * Settings in the iOS app's native frame, from the web's side, on a real
 * build: the frame is configured with Settings' native list, a row of it
 * opens that section's page titled with the section, the web's section picker
 * is not drawn, and true on/off settings are drawn as iOS switches (the same
 * checkboxes). On the website, none of it.
 *
 * The shell is pretended as in native-frame.spec.ts. Each in-app test first
 * checks `<html data-native-frame>`.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 402, height: 874 } });

async function pretendToBeTheIosShell(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const calls: Array<{ method: string; options: unknown }> = [];
    const listeners: Record<string, Array<(data: unknown) => void>> = {};
    w.__frame = { calls, listeners };
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    w.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      PluginHeaders: [
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
      ],
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
  });
}

interface Row {
  id: string;
  title: string;
  path?: string;
  symbol?: string;
}

async function lastConfigure(page: Page) {
  return page.evaluate(() => {
    const calls = (
      window as unknown as { __frame: { calls: Array<{ method: string; options: unknown }> } }
    ).__frame.calls;
    return calls.filter((c) => c.method === 'configure').at(-1)?.options as {
      moreSections: Array<{ items: Row[] }>;
      settings: { title: string; sections: Array<{ items: Row[] }> };
    };
  });
}

async function moreSelect(page: Page, data: { id: string; path?: string }) {
  await page.evaluate((payload) => {
    const frame = (
      window as unknown as { __frame: { listeners: Record<string, Array<(d: unknown) => void>> } }
    ).__frame;
    for (const listener of frame.listeners.moreSelect ?? []) listener(payload);
  }, data);
}

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({ emailPrefix: 'native-settings', householdName: 'List House' });
});

test('in the iOS app: Settings is a native list, each row a titled section with switches', async ({
  page,
}) => {
  await pretendToBeTheIosShell(page);
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');

  await expect.poll(async () => (await lastConfigure(page))?.settings?.sections.length).toBe(4);
  const config = await lastConfigure(page);
  const settingsRow = config.moreSections.flatMap((s) => s.items).find((i) => i.id === 'settings');
  expect(settingsRow?.path).toBe('native:settings');
  expect(config.settings.title).toBe('Settings');
  const rows = config.settings.sections.flatMap((s) => s.items);
  expect(rows.map((r) => r.title)).toEqual([
    'Preferences',
    'Notifications',
    'Plan status',
    'Refer a friend',
    'Plant tags',
    'Wall display',
    'API keys',
    'Trash',
    'Security',
    'Account',
    'About',
  ]);

  // The Notifications row: the web opens that section, titled with it.
  const notifications = rows.find((r) => r.id === 'settings:notifications')!;
  await moreSelect(page, { id: notifications.id, path: notifications.path });
  await expect(page).toHaveURL(/\/settings\?section=notifications$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeAttached();
  await expect(page.getByRole('combobox', { name: /settings section/i })).toBeHidden();
  await expect(page.getByRole('tablist')).toBeHidden();

  // True on/off settings are iOS switches, 51 by 31, and still work.
  const digest = page.getByRole('switch', { name: 'Weekly plant digest' });
  await expect(digest).toBeVisible();
  const box = await digest.boundingBox();
  expect(Math.round(box!.width)).toBe(51);
  expect(Math.round(box!.height)).toBe(31);
  await expect(digest).toBeChecked();
  await digest.click();
  await expect(digest).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Weekly plant digest' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Weekly plant digest' }).click();
  await expect(page.getByRole('switch', { name: 'Weekly plant digest' })).toBeChecked();

  // Plan status: the plan only, no price.
  const plan = rows.find((r) => r.id === 'settings:billing')!;
  await moreSelect(page, { id: plan.id, path: plan.path });
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Plan status' })).toBeAttached();
  await expect(page.locator('#main-content')).not.toContainText(/\$\s*\d/);
});

test('on the website: the picker, tabs and plain checkboxes are all there', async ({ page }) => {
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).not.toHaveAttribute('data-native-frame', /.*/);
  await page.goto('/settings?section=notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: /settings section/i })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Weekly plant digest' })).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);
});
