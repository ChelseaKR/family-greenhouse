import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

/**
 * The Plants list on a phone ("Today first"): the website under 640px and
 * the iOS app. The desktop website keeps its own layout (grid, list and
 * spaces views, the button row and the chips), which is checked here too, so
 * a change to one can never silently become a change to the other.
 */

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'today-first',
    space: { name: 'Sunroom', environment: 'inside' },
    plant: { name: 'Today Fern', species: 'Nephrolepis exaltata' },
    waterTask: { frequency: 7 },
  });
});

async function openPlants(page: Page) {
  await uiLogin(page, account.email, account.password);
  await page.goto('/plants');
}

test.describe('phone website (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('leads with the plant and what it needs, with the toolbar collapsed', async ({ page }) => {
    await openPlants(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Needs care' })).toBeVisible();
    const row = page.getByRole('link', { name: /^Today Fern, Water today, Sunroom/ });
    await expect(row).toBeVisible();

    // On the website the page keeps its own title row above the list.
    const webGap = await page.evaluate(() => {
      const main = document.getElementById('main-content')!.getBoundingClientRect().top;
      const h2 = document.querySelector('#main-content h2')!.getBoundingClientRect().top;
      return h2 - main;
    });
    expect(webGap).toBeGreaterThan(60);

    // The first plant row is on the first screen: nothing but the title and
    // one toolbar row sits above the list.
    const box = await row.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(844 / 2);

    // The old desktop controls are not on the phone.
    await expect(page.getByRole('group', { name: 'View mode' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: /filter plants by space/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /apply template/i })).toBeHidden();

    // Apply template is one tap into the "…" menu and still opens its dialog.
    await page.getByLabel('More plant actions').click();
    await page.getByRole('button', { name: /apply template/i }).click();
    const dialog = page.getByRole('dialog', { name: /apply care template/i });
    await expect(dialog.getByRole('heading', { name: /apply care template/i })).toBeVisible();
  });

  test('the filter menu groups by space and the token clears a filter', async ({ page }) => {
    await openPlants(page);
    await page.getByLabel('Filter plants').click();
    await page.getByRole('button', { name: 'Space', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Sunroom' })).toBeVisible();

    await page.getByLabel('Filter plants').click();
    await page.getByRole('button', { name: 'Outside', exact: true }).click();
    await expect(page.getByText('No plants found')).toBeVisible();
    await page.getByRole('button', { name: 'Remove filter: Outside' }).click();
    await expect(page.getByRole('link', { name: /^Today Fern/ })).toBeVisible();
  });

  test('the menus close on Escape and on a tap outside', async ({ page }) => {
    await openPlants(page);
    const more = page.locator('details', { has: page.getByLabel('More plant actions') });
    await page.getByLabel('More plant actions').click();
    await expect(more).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(more).not.toHaveAttribute('open', '');
    await page.getByLabel('More plant actions').click();
    await page.getByRole('heading', { level: 1, name: 'Plants' }).click();
    await expect(more).not.toHaveAttribute('open', '');
  });
});

test.describe('desktop website (1280px)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('keeps the desktop layout', async ({ page }) => {
    await openPlants(page);
    await expect(page.getByRole('group', { name: 'View mode' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Plant collection' })).toBeVisible();
    await expect(page.getByRole('button', { name: /apply template/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Today Fern/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs care' })).toHaveCount(0);
    await expect(page.getByLabel('Filter plants', { exact: true })).toHaveCount(0);
  });
});

test.describe('iOS app (native frame stub)', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'the shell under test is WebKit');
  test.use({ viewport: { width: 834, height: 1194 } });

  test('uses the phone list at any width, with the bar "+" instead of a web Add', async ({
    page,
  }) => {
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
    await openPlants(page);
    // The pretense took: otherwise this would be testing the website.
    await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
    // An iPad-wide window still gets the phone list inside the app.
    await expect(page.getByRole('heading', { level: 2, name: 'Needs care' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Today Fern, Water today/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^add plant$/i })).toBeHidden();
  });
});

test.describe('iOS app with bar tools (native frame stub)', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'the shell under test is WebKit');
  test.use({ viewport: { width: 402, height: 874 } });

  test('hands search and both menus to the native bar, and follows its picks', async ({ page }) => {
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
    await openPlants(page);
    await expect(page.locator('html')).toHaveAttribute('data-native-frame', '');
    await expect(page.getByRole('heading', { level: 2, name: 'Needs care' })).toBeVisible();

    // The list starts right under the bar: nothing of the page's own header
    // takes room (the h1 is visually hidden for the bar's title), and the top
    // padding is 8pt, not 24pt plus a 12pt gap after an empty header row.
    const gap = await page.evaluate(() => {
      const main = document.getElementById('main-content')!.getBoundingClientRect().top;
      const h2 = document.querySelector('#main-content h2')!.getBoundingClientRect().top;
      return h2 - main;
    });
    expect(gap).toBeLessThanOrEqual(10);

    // The web row is gone; the bar got the menus and the search field.
    await expect(page.getByLabel('Search plants')).toHaveCount(0);
    await expect(page.getByLabel('Filter plants', { exact: true })).toHaveCount(0);
    const sent = await page.waitForFunction(() => {
      const f = (
        window as unknown as {
          __frame: {
            calls: Array<{
              method: string;
              options: { menus: Array<{ id: string }>; search: unknown };
            }>;
          };
        }
      ).__frame;
      const last = f.calls.filter((c) => c.method === 'setBarTools').pop();
      return last && last.options.menus.length === 2 ? last.options : null;
    });
    const tools = (await sent.jsonValue()) as {
      path: string;
      menus: Array<{ id: string }>;
      search: { placeholder: string };
    };
    expect(tools.path).toBe('/plants');
    expect(tools.menus.map((m) => m.id)).toEqual(['filter', 'more']);
    expect(tools.search.placeholder).toBe('Search plants');

    // A pick on the native menu and a search typed in the bar reach the page.
    const fire = (name: string, data: unknown) =>
      page.evaluate(
        ([n, d]) => {
          const f = (
            window as unknown as {
              __frame: { listeners: Record<string, Array<(x: unknown) => void>> };
            }
          ).__frame;
          for (const l of f.listeners[n] ?? []) l(d);
        },
        [name, data] as const
      );
    await fire('barMenuSelect', { path: '/plants', id: 'space:outside' });
    await expect(page.getByText('No plants found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter: Outside' })).toBeVisible();
    await fire('barMenuSelect', { path: '/plants', id: 'space:all' });
    await fire('barSearch', { path: '/plants', text: 'fern' });
    await expect(page.getByText(/1 plant matches “fern”/)).toBeVisible();
  });
});

test.describe('an empty phone list with past plants', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('still reaches the past plants through the "…" menu', async ({ page, request }) => {
    const acct = await provisionAccount({
      emailPrefix: 'today-first-past',
      plant: { name: 'Gone Fern' },
    });
    const login = await request.post('http://localhost:4000/auth/login', {
      data: { email: acct.email, password: acct.password },
    });
    const { idToken } = (await login.json()) as { idToken: string };
    const archived = await request.put(`http://localhost:4000/plants/${acct.plantId}`, {
      headers: { Authorization: `Bearer ${idToken}` },
      data: { status: 'died' },
    });
    expect(archived.ok()).toBeTruthy();

    await uiLogin(page, acct.email, acct.password);
    await page.goto('/plants');
    await expect(page.getByText(/let's add your first plant/i)).toBeVisible();
    await page.getByLabel('More plant actions', { exact: true }).click();
    await page.getByRole('button', { name: 'Past plants' }).click();
    await expect(page.getByRole('link', { name: /Gone Fern/ })).toBeVisible();
  });
});

test.describe('Done with Undo on the phone website', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function freshAccount() {
    return provisionAccount({
      emailPrefix: 'today-first-undo',
      plant: { name: 'Undo Fern' },
      waterTask: { frequency: 7 },
    });
  }

  test('an undone water sends no completion, and the plant is still due', async ({ page }) => {
    const acct = await freshAccount();
    const completions: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/tasks\/[^/]+\/complete$/.test(req.url())) {
        completions.push(req.url());
      }
    });
    await uiLogin(page, acct.email, acct.password);
    await page.goto('/plants');
    await page.getByRole('button', { name: 'Water Undo Fern' }).click();
    await page.getByRole('button', { name: 'Undo: Water Undo Fern' }).click();
    await page.waitForTimeout(6500);
    expect(completions).toEqual([]);
    await page.reload();
    await expect(page.getByRole('link', { name: /^Undo Fern, Water today/ })).toBeVisible();
  });

  test('a water left alone is sent once, after the window, and the plant moves on', async ({
    page,
  }) => {
    const acct = await freshAccount();
    const completions: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/tasks\/[^/]+\/complete$/.test(req.url())) {
        completions.push(req.url());
      }
    });
    await uiLogin(page, acct.email, acct.password);
    await page.goto('/plants');
    await page.getByRole('button', { name: 'Water Undo Fern' }).click();
    await expect(page.getByText('Done: Water, Undo Fern')).toBeVisible();
    await page.waitForTimeout(3000);
    expect(completions).toEqual([]);
    await expect.poll(() => completions.length, { timeout: 6000 }).toBe(1);
    await page.waitForTimeout(2000);
    expect(completions).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('link', { name: /^Undo Fern, Water in 7 days/ })).toBeVisible();
  });
});

test.describe('the status beside the Done button (402pt)', () => {
  test.use({ viewport: { width: 402, height: 874 } });

  for (const mine of [false, true]) {
    test(`the longest status is never clipped; the space name gives way${mine ? ' (your own work: "You")' : ''}`, async ({
      page,
      request,
    }) => {
      const due = new Date();
      due.setDate(due.getDate() - 3);
      const acct = await provisionAccount({
        emailPrefix: 'today-first-status',
        space: { name: 'Sunroom by the big bay window', environment: 'inside' },
        plant: { name: 'Bird of Paradise' },
        waterTask: { frequency: 7, nextDue: due.toISOString() },
      });
      if (mine) {
        const login = await request.post('http://localhost:4000/auth/login', {
          data: { email: acct.email, password: acct.password },
        });
        const { idToken } = (await login.json()) as { idToken: string };
        const claimed = await request.post(`http://localhost:4000/tasks/${acct.taskId}/claim`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        expect(claimed.ok()).toBeTruthy();
      }
      await uiLogin(page, acct.email, acct.password);
      await page.goto('/plants');
      const row = page.getByRole('link', { name: /^Bird of Paradise, Water · 3 days overdue/ });
      if (mine) await expect(row.getByTitle('You')).toHaveText('You');
      await expect(row).toBeVisible();
      await expect(page.getByRole('button', { name: 'Water Bird of Paradise' })).toBeVisible();

      const status = row.getByTestId('row-status');
      await expect(status).toHaveText('Water · 3 days overdue');
      const fit = await status.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const line = el.parentElement!.getBoundingClientRect();
        return {
          clipped: el.scrollWidth > el.clientWidth + 1,
          insideLine: r.right <= line.right + 1,
          width: r.width,
        };
      });
      expect(fit.clipped, 'the status text is clipped').toBe(false);
      expect(fit.insideLine, 'the status runs past its line').toBe(true);
      // And it ends before the Done button starts.
      const button = await page
        .getByRole('button', { name: 'Water Bird of Paradise' })
        .boundingBox();
      const statusBox = await status.boundingBox();
      expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(button!.x);
    });
  }
});

test.describe('the plant page uses the same Undo (phone website)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Watered then Undo sends no completion; Watered left alone sends one', async ({ page }) => {
    const acct = await provisionAccount({
      emailPrefix: 'undo-everywhere',
      plant: { name: 'Undo Lily' },
      waterTask: { frequency: 7 },
    });
    const completions: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/tasks\/[^/]+\/complete$/.test(req.url())) {
        completions.push(req.url());
      }
    });
    await uiLogin(page, acct.email, acct.password);
    await page.goto(`/plants/${acct.plantId}`);
    await page.getByRole('button', { name: 'Water Undo Lily' }).click();
    await page.getByRole('button', { name: 'Undo: Water Undo Lily' }).click();
    await page.waitForTimeout(6500);
    expect(completions).toEqual([]);
    await page.reload();
    await expect(page.getByText('Water today')).toBeVisible();

    await page.getByRole('button', { name: 'Water Undo Lily' }).click();
    await page.waitForTimeout(3000);
    expect(completions).toEqual([]);
    await expect.poll(() => completions.length, { timeout: 6000 }).toBe(1);
    await page.waitForTimeout(2000);
    expect(completions).toHaveLength(1);
  });
});
