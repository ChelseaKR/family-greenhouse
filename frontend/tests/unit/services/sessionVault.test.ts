import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    setDefaultKeychainAccess: vi.fn(async () => undefined),
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: plugin,
  KeychainAccess: { whenUnlocked: 0, afterFirstUnlockThisDeviceOnly: 3 },
}));

import {
  VAULT_READ_TIMEOUT_MS,
  readVaultedRefreshToken,
  resetSessionVaultForTests,
  writeVaultedRefreshToken,
} from '@/services/sessionVault';

const KEY = 'session.refreshToken';

/** The shell with the plugin registered: the bridge lists it, as on a device. */
function pretendToBeTheShell(platform: 'ios' | 'android', { withPlugin = true } = {}) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    ...(withPlugin
      ? {
          PluginHeaders: [
            {
              name: 'SecureStorage',
              methods: [
                { name: 'internalGetItem', rtype: 'promise' },
                { name: 'internalSetItem', rtype: 'promise' },
                { name: 'internalRemoveItem', rtype: 'promise' },
              ],
            },
          ],
        }
      : {}),
  };
}

describe('sessionVault', () => {
  beforeEach(() => {
    plugin.store.clear();
    vi.clearAllMocks();
    resetSessionVaultForTests();
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  describe('on the website', () => {
    it('holds nothing and loads nothing', async () => {
      expect(await readVaultedRefreshToken()).toBeNull();
      await writeVaultedRefreshToken('refresh-1');
      expect(plugin.getItem).not.toHaveBeenCalled();
      expect(plugin.setItem).not.toHaveBeenCalled();
      expect(plugin.setDefaultKeychainAccess).not.toHaveBeenCalled();
    });
  });

  describe('inside a shell whose bridge does not list the plugin', () => {
    // An app build that does not register the plugin, or a test that
    // pretends the shell without it. The plugin's JavaScript must not be
    // driven: its "native" class binds its methods to the bridge proxy's
    // wrappers, and with no header the proxy resolves a wrapper back to the
    // same bound method, an endless chain of promise callbacks that never
    // yields (the page stopped answering; the six e2e failures on 2026-10-09).
    beforeEach(() => pretendToBeTheShell('ios', { withPlugin: false }));

    it('holds nothing and loads nothing, like the website', async () => {
      expect(await readVaultedRefreshToken()).toBeNull();
      await writeVaultedRefreshToken('refresh-1');
      expect(plugin.getItem).not.toHaveBeenCalled();
      expect(plugin.setItem).not.toHaveBeenCalled();
      expect(plugin.setDefaultKeychainAccess).not.toHaveBeenCalled();
    });

    it('is not available when the header lists the plugin without its methods', async () => {
      for (const header of [
        { name: 'SecureStorage', methods: [{ name: 'internalGetItem' }] },
        { name: 'SecureStorage' },
      ]) {
        (window as unknown as { Capacitor?: unknown }).Capacitor = {
          isNativePlatform: () => true,
          getPlatform: () => 'ios',
          PluginHeaders: [header],
        };
        expect(await readVaultedRefreshToken()).toBeNull();
        await writeVaultedRefreshToken('refresh-1');
      }
      expect(plugin.getItem).not.toHaveBeenCalled();
      expect(plugin.setItem).not.toHaveBeenCalled();
    });
  });

  describe.each(['ios', 'android'] as const)('inside the %s shell', (platform) => {
    beforeEach(() => pretendToBeTheShell(platform));

    it('keeps the token in the device keychain, readable only after the first unlock and never in a backup', async () => {
      await writeVaultedRefreshToken('refresh-1');
      expect(plugin.setItem).toHaveBeenCalledWith(KEY, 'refresh-1');
      expect(plugin.setDefaultKeychainAccess).toHaveBeenCalledTimes(1);
      expect(plugin.setDefaultKeychainAccess).toHaveBeenCalledWith(3);

      expect(await readVaultedRefreshToken()).toBe('refresh-1');
      // The plugin was set up once, for both operations.
      expect(plugin.setDefaultKeychainAccess).toHaveBeenCalledTimes(1);
    });

    it('reads an empty vault as nothing', async () => {
      expect(await readVaultedRefreshToken()).toBeNull();
      plugin.store.set(KEY, '');
      expect(await readVaultedRefreshToken()).toBeNull();
    });

    it('reads a keychain that cannot be read as empty', async () => {
      plugin.getItem.mockRejectedValueOnce(new Error('osError'));
      expect(await readVaultedRefreshToken()).toBeNull();
    });

    it('removes the token on a null write', async () => {
      await writeVaultedRefreshToken('refresh-1');
      await writeVaultedRefreshToken(null);
      expect(plugin.removeItem).toHaveBeenCalledWith(KEY);
      expect(await readVaultedRefreshToken()).toBeNull();
    });

    it('lands writes in the order they were asked for, even when the first is slow', async () => {
      const order: string[] = [];
      plugin.setItem.mockImplementationOnce(async (key: string, value: string) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        plugin.store.set(key, value);
        order.push('set');
      });
      plugin.removeItem.mockImplementationOnce(async (key: string) => {
        plugin.store.delete(key);
        order.push('remove');
      });

      // A sign-in followed at once by a sign-out: the device must end up
      // holding nothing, not the sign-in's token.
      const first = writeVaultedRefreshToken('refresh-1');
      const second = writeVaultedRefreshToken(null);
      await Promise.all([first, second]);

      expect(order).toEqual(['set', 'remove']);
      expect(plugin.store.has(KEY)).toBe(false);
    });

    it('never rejects on a failed write', async () => {
      plugin.setItem.mockRejectedValueOnce(new Error('osError'));
      await expect(writeVaultedRefreshToken('refresh-1')).resolves.toBeUndefined();
      // The chain is not poisoned: the next write still goes through.
      await writeVaultedRefreshToken('refresh-2');
      expect(plugin.store.get(KEY)).toBe('refresh-2');
    });
  });
});

/**
 * Capacitor plugins are Proxies: reading any property, `then` included,
 * yields a bridge call. Resolving a promise with the plugin object makes the
 * promise machinery call that `then`, which never answers, and the promise
 * never settles. Measured on the production build with the shell pretended:
 * "SecureStorage.then() is not implemented on ios", and a launch that waited
 * on it forever. The mock above is a plain object and cannot show it; this
 * one behaves like the real proxy.
 */
describe('sessionVault with a plugin that is a Capacitor proxy', () => {
  beforeEach(() => {
    plugin.store.clear();
    vi.clearAllMocks();
    resetSessionVaultForTests();
    pretendToBeTheShell('ios');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('still reads and writes when the plugin object has a `then` that never answers', async () => {
    const touched = new Set<string | symbol>();
    const proxyLike = new Proxy(plugin, {
      get(target, prop) {
        touched.add(prop);
        // What the bridge does for a method the plugin does not list: a
        // wrapper whose promise never settles and whose callbacks are
        // never called.
        if (prop === 'then') return () => new Promise(() => undefined);
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
    const module = await import('@aparajita/capacitor-secure-storage');
    const real = module.SecureStorage;
    (module as { SecureStorage: unknown }).SecureStorage = proxyLike;
    try {
      const write = writeVaultedRefreshToken('refresh-1');
      await vi.advanceTimersByTimeAsync(10);
      await write;
      expect(plugin.store.get(KEY)).toBe('refresh-1');

      const read = readVaultedRefreshToken();
      await vi.advanceTimersByTimeAsync(10);
      expect(await read).toBe('refresh-1');
      // The proxy, not the plain mock, is what answered.
      expect(touched.has('setItem')).toBe(true);
      expect(touched.has('getItem')).toBe(true);
    } finally {
      (module as { SecureStorage: unknown }).SecureStorage = real;
    }
  });

  it('answers "nothing stored" rather than never, when the keychain does not answer', async () => {
    plugin.getItem.mockImplementationOnce(() => new Promise(() => undefined));
    const read = readVaultedRefreshToken();
    await vi.advanceTimersByTimeAsync(VAULT_READ_TIMEOUT_MS + 1);
    expect(await read).toBeNull();
  });
});
