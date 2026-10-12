import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * Add care task as a native form sheet in the iOS app (NativeChrome
 * `presentForm`), from the web's side, on a real build against the mock API.
 * The stub keeps each `presentForm` call open until the test answers it as
 * Swift would: `{ values }` for the sheet's Add button, `{ values: null }` for
 * Cancel or a swipe down. Only a submit may write.
 */
test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 402, height: 874 } });

async function pretendToBeTheIosShell(page: Page, { canForm }: { canForm: boolean }) {
  await page.addInitScript((form) => {
    const w = window as unknown as Record<string, unknown>;
    const forms: unknown[] = [];
    const answers: Array<(value: unknown) => void> = [];
    w.__forms = { forms, answers };
    w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    const methods = [
      'configure',
      'update',
      'present',
      'updatePresented',
      'dismissPresented',
      ...(form ? ['presentForm'] : []),
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
        if (plugin === 'NativeChrome' && method === 'presentForm') {
          forms.push(options);
          return new Promise((resolve) => answers.push(resolve));
        }
        return Promise.resolve();
      },
      nativeCallback: () => 'callback',
    };
  }, canForm);
}

const formCalls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __forms: { forms: Array<{ title: string }> } }).__forms.forms.length
  );

async function answerForm(page: Page, index: number, values: Record<string, unknown> | null) {
  await page.evaluate(
    ([i, v]) => {
      (window as unknown as { __forms: { answers: Array<(x: unknown) => void> } }).__forms.answers[
        i
      ]({ values: v });
    },
    [index, values] as const
  );
}

let account: ProvisionedAccount;
test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'native-form',
    plant: { name: 'Form Fern' },
  });
});

async function openPlant(page: Page) {
  await page.goto('/plants');
  await page
    .getByRole('link', { name: /Form Fern/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Form Fern' })).toBeAttached();
}

test('in the iOS app, Add care task is a native sheet: dismissing writes nothing, Add writes', async ({
  page,
}) => {
  await pretendToBeTheIosShell(page, { canForm: true });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
  await openPlant(page);

  await page.getByRole('button', { name: 'Add task' }).first().click();
  await expect.poll(() => formCalls(page)).toBe(1);
  // The sheet is native: no web dialog behind it.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Cancel or a swipe down: nothing is written.
  await answerForm(page, 0, null);
  await page.waitForTimeout(500);
  await expect(page.getByText('Fertilize', { exact: false })).toHaveCount(0);

  // Again, and Add.
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await expect.poll(() => formCalls(page)).toBe(2);
  await answerForm(page, 1, { type: 'fertilize', frequency: 14, notes: '' });
  await expect(page.getByText(/Fertilize/).first()).toBeVisible();
});

test('an app without form sheets keeps the web dialog', async ({ page }) => {
  await pretendToBeTheIosShell(page, { canForm: false });
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
  await openPlant(page);
  await page.getByRole('button', { name: 'Add task' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add care task' })).toBeVisible();
  expect(await formCalls(page)).toBe(0);
});
