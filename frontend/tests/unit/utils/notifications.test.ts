/**
 * The browser-notification wrapper. The load-bearing rule is that a local
 * "yes, remind me" flag alone never authorizes a notification — the live
 * permission must still be granted, and construction failures stay silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableLocally,
  getPermission,
  isEnabledLocally,
  isSupported,
  notify,
  requestPermission,
} from '@/utils/notifications';

const STORAGE_KEY = 'fg.notifications.enabled';

const constructed: Array<{ title: string; options?: NotificationOptions }> = [];
let requestResult: NotificationPermission = 'granted';
let constructorThrows = false;

function installNotification(permission: NotificationPermission) {
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = requestResult;
      return requestResult;
    });
    constructor(title: string, options?: NotificationOptions) {
      if (constructorThrows) throw new Error('Illegal constructor');
      constructed.push({ title, options });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return FakeNotification;
}

beforeEach(() => {
  constructed.length = 0;
  constructorThrows = false;
  requestResult = 'granted';
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notification support detection', () => {
  it('reports unsupported when the browser has no Notification API', () => {
    vi.stubGlobal('Notification', undefined);
    // `undefined` still satisfies `'Notification' in window`, so remove it.
    Reflect.deleteProperty(window, 'Notification');

    expect(isSupported()).toBe(false);
    expect(getPermission()).toBe('unsupported');
    expect(isEnabledLocally()).toBe(false);
    expect(notify('hi')).toBe(false);
    expect(constructed).toHaveLength(0);
  });

  it('returns the live permission when supported', () => {
    installNotification('denied');

    expect(isSupported()).toBe(true);
    expect(getPermission()).toBe('denied');
  });
});

describe('requestPermission', () => {
  it('persists the opt-in only when the user grants', async () => {
    installNotification('default');

    await expect(requestPermission()).resolves.toBe('granted');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('stores nothing when the user denies', async () => {
    requestResult = 'denied';
    installNotification('default');

    await expect(requestPermission()).resolves.toBe('denied');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('short-circuits on an unsupported browser', async () => {
    Reflect.deleteProperty(window, 'Notification');

    await expect(requestPermission()).resolves.toBe('unsupported');
  });
});

describe('isEnabledLocally', () => {
  it('requires both the stored opt-in and a granted permission', () => {
    installNotification('granted');
    expect(isEnabledLocally()).toBe(false);

    localStorage.setItem(STORAGE_KEY, '1');
    expect(isEnabledLocally()).toBe(true);
  });

  it('is false when permission was revoked after the opt-in', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    installNotification('denied');

    expect(isEnabledLocally()).toBe(false);
  });
});

describe('notify', () => {
  it('fires with the brand icon defaults and lets callers override them', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    installNotification('granted');

    expect(notify('Water the pothos', { body: 'Due today', icon: '/custom.png' })).toBe(true);

    expect(constructed).toEqual([
      {
        title: 'Water the pothos',
        options: { icon: '/custom.png', badge: '/brand/icon-192.png', body: 'Due today' },
      },
    ]);
  });

  it('stays silent when the user has not opted in', () => {
    installNotification('granted');

    expect(notify('Water the pothos')).toBe(false);

    expect(constructed).toHaveLength(0);
  });

  it('swallows browsers that reject Notification construction and reports it was NOT shown', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    installNotification('granted');
    constructorThrows = true;

    // A swallowed throw is a failed send, not a delivered one — callers that
    // dedupe "already announced" must be able to tell the difference.
    expect(notify('Water the pothos')).toBe(false);
  });
});

describe('disableLocally', () => {
  it('clears the stored opt-in', () => {
    localStorage.setItem(STORAGE_KEY, '1');

    disableLocally();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
