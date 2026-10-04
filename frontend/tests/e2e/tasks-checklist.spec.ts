import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * The Tasks tab on a phone ("Checklist"): the website under 640px and the
 * iOS app. The desktop website keeps its own layout (the chips and the By
 * date / Care round toggle), which is checked here too, so a change to one
 * can never silently become a change to the other.
 */

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'tasks-checklist',
    space: { name: 'Sunroom', environment: 'inside' },
    plant: { name: 'Checklist Fern', species: 'Nephrolepis exaltata' },
    waterTask: { frequency: 7 },
  });
});

async function openTasks(page: Page) {
  await uiLogin(page, account.email, account.password);
  await page.goto('/tasks');
}

const fernRow = (page: Page) => page.getByRole('link', { name: /^Checklist Fern, Water, Sunroom/ });

test.describe('phone website (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('leads with the task, on the first screen, without the desktop controls', async ({
    page,
  }) => {
    await openTasks(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Today' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Today 1$/, pressed: true })).toBeVisible();
    const row = fernRow(page);
    await expect(row).toBeVisible();
    // Nobody has it yet: the row says so, and never "Assigned to".
    await expect(row).toHaveAccessibleName(/Up for grabs$/);
    const box = await row.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(844 / 2);

    await expect(page.getByRole('group', { name: 'Task filters' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Care round' })).toHaveCount(0);
    await expect(page.getByText(/Assigned to/)).toHaveCount(0);
  });

  test('the check circle marks it done with Undo, and Undo puts it back', async ({ page }) => {
    await openTasks(page);
    await page.getByRole('button', { name: 'Water Checklist Fern' }).click();
    await expect(page.getByRole('button', { name: 'Undo: Water Checklist Fern' })).toBeVisible();
    await page.getByRole('button', { name: 'Undo: Water Checklist Fern' }).click();
    await expect(page.getByRole('button', { name: 'Water Checklist Fern' })).toBeVisible();
  });

  test('the row actions open without a gesture, and the filter menu filters', async ({ page }) => {
    await openTasks(page);
    await expect(fernRow(page)).toBeVisible();
    const actions = page.getByRole('button', { name: 'Actions for Checklist Fern' });
    await actions.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Checklist Fern' });
    await expect(sheet.getByRole('button', { name: 'I’ll do it' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Ask family…' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toBeHidden();

    await page.getByLabel('Filter tasks').click();
    await page.getByRole('button', { name: 'Only mine', exact: true }).click();
    // A filter that hides everything says so, never "All done for today".
    await expect(page.getByText('No tasks match these filters.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'All done for today' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(fernRow(page)).toBeVisible();
    await page.getByLabel('Filter tasks').click();
    await page.getByRole('button', { name: 'Only mine', exact: true }).click();
    await page.getByRole('button', { name: 'Remove filter: Only mine' }).click();
    await expect(fernRow(page)).toBeVisible();

    await page.getByRole('button', { name: /^Upcoming/ }).click();
    await expect(page.getByText('Nothing is scheduled after today.')).toBeVisible();
  });
});

test.describe('snooze from the row (phone website)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Snooze asks how long, then the task moves to Upcoming', async ({ page }) => {
    // Its own household: this one writes.
    const own = await provisionAccount({
      emailPrefix: 'tasks-snooze',
      space: { name: 'Hall', environment: 'inside' },
      plant: { name: 'Snooze Ivy' },
      waterTask: { frequency: 7 },
    });
    await uiLogin(page, own.email, own.password);
    await page.goto('/tasks');
    const row = page.getByRole('link', { name: /^Snooze Ivy, Water, Hall/ });
    await expect(row).toBeVisible();
    const actions = page.getByRole('button', { name: 'Actions for Snooze Ivy' });
    await actions.click();
    await page
      .getByRole('dialog', { name: 'Snooze Ivy' })
      .getByRole('button', { name: 'Snooze…' })
      .click();
    await page
      .getByRole('dialog', { name: 'Snooze' })
      .getByRole('button', { name: '3 days' })
      .click();
    await expect(page.getByRole('heading', { name: 'All done for today' })).toBeVisible();
    await page.getByRole('button', { name: /^Upcoming/ }).click();
    await expect(page.getByRole('link', { name: /^Snooze Ivy, Water, Hall/ })).toBeVisible();
  });
});

test.describe('desktop website (1280px)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('keeps the chips and the By date / Care round toggle', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByRole('group', { name: 'Task filters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Care round' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Show tasks for' })).toHaveCount(0);
  });
});

test.describe('iOS app (native frame stub)', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'the shell under test is WebKit');
  test.use({ viewport: { width: 834, height: 1194 } });

  test('uses the checklist at any width inside the app', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
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
        nativePromise: () => Promise.resolve(),
        nativeCallback: () => 'callback',
      };
    });
    await openTasks(page);
    // The pretense took: otherwise this would be testing the website.
    await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
    await expect(page.getByRole('group', { name: 'Show tasks for' })).toBeVisible();
    await expect(fernRow(page)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Task filters' })).toHaveCount(0);
  });
});

test.describe('iOS app with bar tools (native frame stub)', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'the shell under test is WebKit');
  test.use({ viewport: { width: 402, height: 874 } });

  test('hands the filter menu to the bar, follows its picks, and keeps no back button', async ({
    page,
  }) => {
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
              { name: 'setBarTools', rtype: 'promise' },
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
    await uiLogin(page, account.email, account.password);
    await page.goto('/tasks?filter=today');
    await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
    await expect(fernRow(page)).toBeVisible();
    await expect(page.getByLabel('Filter tasks')).toHaveCount(0);

    type Call = { method: string; options: Record<string, unknown> };
    const calls = () =>
      page.evaluate(() => (window as unknown as { __frame: { calls: Call[] } }).__frame.calls);
    // The tab's first screen, query and all: no back button, a large title.
    await expect
      .poll(async () =>
        (await calls())
          .filter((c) => c.method === 'update')
          .map((c) => c.options)
          .filter((o) => o.path === '/tasks?filter=today')
          .map((o) => [o.canGoBack, o.largeTitle])
          .pop()
      )
      .toEqual([false, true]);
    // The filter menu, filed under the same path.
    await expect
      .poll(async () => {
        const tools = (await calls()).filter((c) => c.method === 'setBarTools').pop()?.options;
        return tools ? [tools.path, (tools.menus as Array<{ id: string }>).map((m) => m.id)] : null;
      })
      .toEqual(['/tasks?filter=today', ['filter']]);

    await page.evaluate(() => {
      const f = (
        window as unknown as {
          __frame: { listeners: Record<string, Array<(x: unknown) => void>> };
        }
      ).__frame;
      for (const l of f.listeners.barMenuSelect ?? [])
        l({ path: '/tasks?filter=today', id: 'who:mine' });
    });
    await expect(page.getByText('No tasks match these filters.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter: Only mine' })).toBeVisible();
    // The pick changed the page, not the URL: still the same screen.
    expect(new URL(page.url()).search).toBe('?filter=today');
  });
});
