import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

/**
 * The app stays signed in (ADR 0034), from the web's side, on a real build.
 *
 * Inside the iOS/Android shells the refresh token lives in the device
 * keychain, never in web storage, and a launch reads it back before the
 * session is judged. Relaunching the app is what ends a WebView's
 * sessionStorage, so a relaunch is played here as `sessionStorage.clear()`
 * plus a reload; the keychain, which outlives the WebView, is played by a
 * localStorage key of its own that the pretend bridge serves to the plugin
 * and nothing else reads. Every scenario also records whether the sign-in
 * screen was ever on screen, because "signed in again after a flash of the
 * sign-in form" is the failure the splash screen would otherwise hide.
 *
 * The iOS shell is pretended as in native-frame.spec.ts, with a
 * `PluginHeaders` entry for the SecureStorage plugin so its calls reach the
 * pretend bridge instead of its web fallback.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 402, height: 874 } });

/** Where the pretend keychain keeps its items. Not an app key. */
const KEYCHAIN = '__pretendKeychain';
/** The plugin's own prefix plus the key services/sessionVault.ts uses. */
const REFRESH_TOKEN_ITEM = 'capacitor-storage_session.refreshToken';

async function pretendToBeTheIosShell(page: Page) {
  await page.addInitScript(
    ({ keychainKey }) => {
      const w = window as unknown as Record<string, unknown>;
      const keychain = {
        read(): Record<string, string> {
          try {
            return JSON.parse(localStorage.getItem(keychainKey) ?? '{}') as Record<string, string>;
          } catch {
            return {};
          }
        },
        write(items: Record<string, string>) {
          localStorage.setItem(keychainKey, JSON.stringify(items));
        },
      };
      w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        PluginHeaders: [
          {
            name: 'SecureStorage',
            methods: [
              { name: 'setSynchronizeKeychain', rtype: 'promise' },
              { name: 'internalGetItem', rtype: 'promise' },
              { name: 'internalSetItem', rtype: 'promise' },
              { name: 'internalRemoveItem', rtype: 'promise' },
              { name: 'internalClearItemsWithPrefix', rtype: 'promise' },
              { name: 'internalGetPrefixedKeys', rtype: 'promise' },
            ],
          },
        ],
        nativePromise: (
          plugin: string,
          method: string,
          options: { prefixedKey?: string; data?: string; prefix?: string }
        ) => {
          if (plugin !== 'SecureStorage') return Promise.resolve();
          const items = keychain.read();
          const key = options.prefixedKey ?? '';
          switch (method) {
            case 'internalGetItem':
              return Promise.resolve({ data: key in items ? items[key] : null });
            case 'internalSetItem':
              items[key] = options.data ?? '';
              keychain.write(items);
              return Promise.resolve();
            case 'internalRemoveItem': {
              const had = key in items;
              delete items[key];
              keychain.write(items);
              return Promise.resolve({ success: had });
            }
            case 'internalClearItemsWithPrefix':
              for (const k of Object.keys(items))
                if (k.startsWith(options.prefix ?? '')) delete items[k];
              keychain.write(items);
              return Promise.resolve();
            case 'internalGetPrefixedKeys':
              return Promise.resolve({ keys: Object.keys(items) });
            default:
              return Promise.resolve();
          }
        },
        nativeCallback: () => 'callback',
      };
      // Was the sign-in form ever on screen in this page load?
      w.__sawSignIn = false;
      const observer = new MutationObserver(() => {
        if (document.querySelector('input[type="password"]')) w.__sawSignIn = true;
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    },
    { keychainKey: KEYCHAIN }
  );
}

interface Storage {
  local: string;
  session: string;
  keychain: Record<string, string>;
}

function readStorage(page: Page): Promise<Storage> {
  return page.evaluate((keychainKey) => {
    return {
      local: localStorage.getItem('auth-storage') ?? '',
      session: sessionStorage.getItem('auth-storage-session') ?? '',
      keychain: JSON.parse(localStorage.getItem(keychainKey) ?? '{}') as Record<string, string>,
    };
  }, KEYCHAIN);
}

/**
 * One field of a persisted zustand payload (`{"state":{...}}`), or undefined.
 * Read as a field, not as a substring: the local mock mints the same string
 * for the ID, access and refresh tokens, so "the refresh token's value is not
 * in localStorage" would be false there for the wrong reason.
 */
function storedField(json: string, field: string): unknown {
  if (!json) return undefined;
  const parsed = JSON.parse(json) as { state?: Record<string, unknown> };
  return parsed.state?.[field];
}

function sawSignIn(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sawSignIn: boolean }).__sawSignIn);
}

/** A relaunch of the app: the WebView's sessionStorage is gone, the rest stays. */
async function relaunch(page: Page) {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
}

async function expectSignedInWithNoSignInScreen(page: Page) {
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  // The first screen's heading, which is what releases the launch screen.
  await expect(page.locator('#main-content h1').first()).toBeVisible({ timeout: 15000 });
  expect(await sawSignIn(page), 'the sign-in form must never have been on screen').toBe(false);
}

/** An unsigned JWT-shaped token that expired an hour ago. */
function expiredJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 }))
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

test.describe('inside the iOS shell', () => {
  test('the sign-in screen says the device stays signed in, and offers no checkbox', async ({
    page,
  }) => {
    await pretendToBeTheIosShell(page);
    await page.goto('/login');
    await expect(page.getByText(/this device stays signed in until you sign out\./i)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /forgot/i })).toBeVisible();
  });

  test('a relaunch keeps the session: with a live ID token, with an expired one, and not after sign-out', async ({
    page,
  }) => {
    await pretendToBeTheIosShell(page);
    const account = await provisionAccount({ emailPrefix: 'stays-signed-in' });
    await uiLogin(page, account.email, account.password);

    // Where the tokens landed: the refresh token in the keychain and in
    // neither web storage, the ID token in localStorage.
    const afterSignIn = await readStorage(page);
    const refreshToken = afterSignIn.keychain[REFRESH_TOKEN_ITEM];
    expect(refreshToken, 'the keychain holds the refresh token').toBeTruthy();
    expect(storedField(afterSignIn.local, 'refreshToken')).toBeUndefined();
    expect(storedField(afterSignIn.session, 'refreshToken')).toBeUndefined();
    expect(storedField(afterSignIn.local, 'idToken')).toBeTruthy();
    expect(storedField(afterSignIn.local, 'isAuthenticated')).toBe(true);

    // 1. Relaunch while the ID token is still good.
    await relaunch(page);
    await expectSignedInWithNoSignInScreen(page);

    // 2. Relaunch after the ID token has expired: the keychain token is
    //    restored first and the session is refreshed with it, silently.
    await page.evaluate((expired) => {
      const raw = JSON.parse(localStorage.getItem('auth-storage') ?? '{}') as {
        state: Record<string, unknown>;
      };
      raw.state.idToken = expired;
      raw.state.accessToken = 'expired';
      localStorage.setItem('auth-storage', JSON.stringify(raw));
    }, expiredJwt());
    await relaunch(page);
    await expectSignedInWithNoSignInScreen(page);
    const afterRefresh = await readStorage(page);
    expect(storedField(afterRefresh.local, 'accessToken')).not.toBe('expired');
    expect(afterRefresh.keychain[REFRESH_TOKEN_ITEM]).toBe(refreshToken);
    expect(storedField(afterRefresh.local, 'refreshToken')).toBeUndefined();

    // 3. Signing out empties the keychain, and the next launch starts on
    //    sign-in.
    const hamburger = page.getByRole('button', { name: /open sidebar/i });
    if (await hamburger.isVisible()) await hamburger.click();
    await page
      .getByRole('button', { name: /sign out/i })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    const afterSignOut = await readStorage(page);
    expect(afterSignOut.keychain[REFRESH_TOKEN_ITEM]).toBeUndefined();
    expect(storedField(afterSignOut.local, 'idToken')).toBeNull();

    await relaunch(page);
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await expect(page.getByLabel(/password/i)).toBeVisible({ timeout: 15000 });
  });
});

test.describe('on the website', () => {
  test('nothing changed: an unremembered session still ends with the tab', async ({ page }) => {
    const account = await provisionAccount({ emailPrefix: 'web-session-unchanged' });
    await uiLogin(page, account.email, account.password);

    const storage = await page.evaluate(() => ({
      local: localStorage.getItem('auth-storage') ?? '',
      session: sessionStorage.getItem('auth-storage-session') ?? '',
      keychain: Object.keys(localStorage).filter((k) => k.startsWith('capacitor-storage_')),
    }));
    expect(storedField(storage.session, 'refreshToken')).toBeTruthy();
    expect(storedField(storage.local, 'refreshToken')).toBeUndefined();
    expect(storage.keychain).toEqual([]);
  });
});
