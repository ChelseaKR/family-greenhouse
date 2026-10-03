import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * Confirmations and choices as Apple's own alerts and action sheets in the
 * iOS app (NativeChrome `present`), from the web's side, on a real build.
 *
 * The iOS shell is pretended as in native-frame.spec.ts, with `present` in
 * the plugin's method list. The stub keeps every `present` call unanswered
 * until the test answers it the way Swift would: the tapped action's id, or
 * `{ id: null }` for Cancel, a tap outside, a swipe or the app going to the
 * background. Each in-app test first checks `<html data-native-frame>`, so a
 * "website" result can never come from the pretense not taking.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 402, height: 874 } });

interface PresentCall {
  token: string;
  kind: string;
  title?: string;
  actions: Array<{ id: string; title: string; style: string }>;
}

async function pretendToBeTheIosShell(page: Page, { canPresent }: { canPresent: boolean }) {
  await page.addInitScript((present) => {
    const w = window as unknown as Record<string, unknown>;
    const presents: unknown[] = [];
    const answers: Array<(value: unknown) => void> = [];
    w.__sheets = { presents, answers };
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    const methods = [
      'configure',
      'update',
      ...(present ? ['present', 'updatePresented', 'dismissPresented'] : []),
    ];
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
            ...methods.map((name) => ({ name, rtype: 'promise' })),
          ],
        },
      ],
      nativePromise: (plugin: string, method: string, options: unknown) => {
        if (plugin === 'NativeChrome' && method === 'present') {
          presents.push(options);
          return new Promise((resolve) => answers.push(resolve));
        }
        return Promise.resolve();
      },
      nativeCallback: () => 'callback',
    };
  }, canPresent);
}

async function presents(page: Page): Promise<PresentCall[]> {
  return page.evaluate(
    () => (window as unknown as { __sheets: { presents: PresentCall[] } }).__sheets.presents
  );
}

/** The person ends the sheet showing: an action's id, or null. */
async function answer(page: Page, index: number, id: string | null) {
  await page.evaluate(
    ([i, value]) => {
      (
        window as unknown as { __sheets: { answers: Array<(v: unknown) => void> } }
      ).__sheets.answers[i]({ id: value });
    },
    [index, id] as const
  );
}

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'native-sheets',
    householdName: 'Sheet House',
    plant: { name: 'Sheet Fern' },
  });
});

async function openPlant(page: Page) {
  await page.goto('/plants');
  await page
    .getByRole('link', { name: /Sheet Fern/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sheet Fern' })).toBeAttached();
}

test('in the iOS app, Remove opens a native action sheet; dismissing it changes nothing', async ({
  page,
}) => {
  await pretendToBeTheIosShell(page, { canPresent: true });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
  await openPlant(page);

  await page.getByRole('button', { name: /^remove$/i }).click();
  await expect.poll(async () => (await presents(page)).length).toBe(1);
  const [sheet] = await presents(page);
  expect(sheet.kind).toBe('actionSheet');
  expect(sheet.title).toBe('Move Sheet Fern out of active care?');
  expect(sheet.actions.map((a) => [a.id, a.style])).toEqual([
    ['archive', 'default'],
    ['gaveAway', 'default'],
    ['passport', 'default'],
    ['died', 'default'],
    ['delete', 'destructive'],
    ['cancel', 'cancel'],
  ]);
  // No web dialog between the native bars.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Swiped away / tapped outside / backgrounded: Swift answers no choice.
  await answer(page, 0, null);
  // Cancel.
  await page.getByRole('button', { name: /^remove$/i }).click();
  await expect.poll(async () => (await presents(page)).length).toBe(2);
  await answer(page, 1, 'cancel');

  // Still on the plant, still active after a fresh read from the server.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sheet Fern' })).toBeAttached();
  await expect(page.getByRole('button', { name: /^remove$/i })).toBeVisible();
});

test('in the iOS app, Delete asks again in a red alert, and only its red button deletes', async ({
  page,
}) => {
  await pretendToBeTheIosShell(page, { canPresent: true });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
  await openPlant(page);

  await page.getByRole('button', { name: /^remove$/i }).click();
  await expect.poll(async () => (await presents(page)).length).toBe(1);
  await answer(page, 0, 'delete');
  await expect.poll(async () => (await presents(page)).length).toBe(2);
  const confirm = (await presents(page))[1];
  expect(confirm.kind).toBe('alert');
  expect(confirm.actions.map((a) => a.style)).toEqual(['destructive', 'cancel']);
  await answer(page, 1, null);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sheet Fern' })).toBeAttached();
});

test('on the website: the web dialog, and nothing asks for a native sheet', async ({ page }) => {
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).not.toHaveAttribute('data-native-frame', /.*/);
  await openPlant(page);
  await page.getByRole('button', { name: /^remove$/i }).click();
  await expect(
    page.getByRole('dialog', { name: /Move Sheet Fern out of active care/ })
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: /Move Sheet Fern out of active care/ })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an iOS frame that cannot present keeps the web dialog', async ({ page }) => {
  await pretendToBeTheIosShell(page, { canPresent: false });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
  await openPlant(page);
  await page.getByRole('button', { name: /^remove$/i }).click();
  await expect(
    page.getByRole('dialog', { name: /Move Sheet Fern out of active care/ })
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: /Move Sheet Fern out of active care/ })
  ).toBeVisible();
  expect(await presents(page)).toEqual([]);
});
