import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { registerSW } = vi.hoisted(() => ({ registerSW: vi.fn() }));
vi.mock('virtual:pwa-register', () => ({ registerSW }));

import { initPwaRegistration } from '@/services/pwaRegistration';

const unregister = vi.fn(() => Promise.resolve(true));
const getRegistrations = vi.fn(() => Promise.resolve([{ unregister }]));
const deleteCache = vi.fn((_name: string) => Promise.resolve(true));
const cacheKeys = vi.fn(() =>
  Promise.resolve(['workbox-precache-v2-https://localhost/', 'images', 'something-else'])
);

async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('initPwaRegistration', () => {
  beforeEach(() => {
    registerSW.mockClear();
    unregister.mockClear();
    deleteCache.mockClear();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations },
    });
    vi.stubGlobal('caches', { keys: cacheKeys, delete: deleteCache });
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    vi.unstubAllGlobals();
  });

  it('registers the worker on the website', () => {
    initPwaRegistration();
    expect(registerSW).toHaveBeenCalledTimes(1);
    expect(getRegistrations).not.toHaveBeenCalled();
  });

  describe('inside the native shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
      };
    });

    it('registers nothing, so the app always starts from the files in the binary', () => {
      initPwaRegistration();
      expect(registerSW).not.toHaveBeenCalled();
    });

    it("removes a worker an earlier build left behind, and only that worker's caches", async () => {
      initPwaRegistration();
      await settle();
      expect(unregister).toHaveBeenCalledTimes(1);
      expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
        'workbox-precache-v2-https://localhost/',
        'images',
      ]);
    });
  });
});
