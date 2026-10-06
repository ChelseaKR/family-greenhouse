import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativePlugin = vi.hoisted(() => ({
  callbacks: {} as Record<
    string,
    ((value: { value?: string; error?: string }) => void) | undefined
  >,
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  removeAllDeliveredNotifications: vi.fn(),
  removeRegistration: vi.fn(),
  removeRegistrationError: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  api: { post: vi.fn() },
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: nativePlugin.checkPermissions,
    requestPermissions: nativePlugin.requestPermissions,
    addListener: nativePlugin.addListener,
    register: nativePlugin.register,
    unregister: nativePlugin.unregister,
    removeAllDeliveredNotifications: nativePlugin.removeAllDeliveredNotifications,
  },
}));

import { api } from '@/services/api';
import {
  nativePushOffered,
  registerNativePush,
  signOutNativePush,
  syncNativePush,
  unregisterNativePush,
} from '@/services/nativePush';

describe('native push registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePlugin.callbacks = {};
    localStorage.clear();
    // A push build on iOS, unless a test says otherwise: registerNativePush()
    // no-ops in a build that does not carry push for its platform.
    vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    nativePlugin.checkPermissions.mockResolvedValue({ receive: 'granted' });
    nativePlugin.addListener.mockImplementation(
      async (event: string, callback: (value: { value?: string; error?: string }) => void) => {
        nativePlugin.callbacks[event] = callback;
        return {
          remove:
            event === 'registration'
              ? nativePlugin.removeRegistration
              : nativePlugin.removeRegistrationError,
        };
      }
    );
    nativePlugin.removeRegistration.mockResolvedValue(undefined);
    nativePlugin.unregister.mockResolvedValue(undefined);
    nativePlugin.removeAllDeliveredNotifications.mockResolvedValue(undefined);
    nativePlugin.removeRegistrationError.mockResolvedValue(undefined);
    vi.mocked(api.post).mockResolvedValue({} as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('attaches both listeners before registering and removes them after saving the token', async () => {
    nativePlugin.register.mockImplementation(async () => {
      nativePlugin.callbacks.registration?.({ value: 'apns-token-1' });
    });

    await expect(registerNativePush()).resolves.toBe(true);

    const addOrders = nativePlugin.addListener.mock.invocationCallOrder;
    expect(addOrders).toHaveLength(2);
    expect(nativePlugin.register.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...addOrders)
    );
    expect(api.post).toHaveBeenCalledWith('/notifications/devices', {
      platform: 'ios',
      token: 'apns-token-1',
    });
    expect(localStorage.getItem('fg.nativePush.token')).toBe('apns-token-1');
    expect(nativePlugin.removeRegistration).toHaveBeenCalledOnce();
    expect(nativePlugin.removeRegistrationError).toHaveBeenCalledOnce();
  });

  it('cleans up both listeners when native registration reports an error', async () => {
    nativePlugin.register.mockImplementation(async () => {
      nativePlugin.callbacks.registrationError?.({ error: 'APNs unavailable' });
    });

    await expect(registerNativePush()).rejects.toThrow('APNs unavailable');

    expect(api.post).not.toHaveBeenCalled();
    expect(localStorage.getItem('fg.nativePush.token')).toBeNull();
    expect(nativePlugin.removeRegistration).toHaveBeenCalledOnce();
    expect(nativePlugin.removeRegistrationError).toHaveBeenCalledOnce();
  });

  describe('off until setup is done', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('is offered only in a push build, inside a shell, for a platform the deployment can reach', () => {
      vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'false');
      expect(nativePushOffered({ ios: true, android: true })).toBe(false);

      vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
      expect(nativePushOffered(undefined)).toBe(false); // older server
      expect(nativePushOffered({ ios: false, android: true })).toBe(false); // this is iOS
      expect(nativePushOffered({ ios: true, android: false })).toBe(true);

      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
      expect(nativePushOffered({ ios: true, android: true })).toBe(false); // the website
    });

    it('never touches the plugin or the server while the build flag is off', async () => {
      vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'false');
      localStorage.setItem('fg.nativePush.token', 'apns-token-1');
      await syncNativePush();
      expect(nativePlugin.checkPermissions).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('never calls register() in a build that carries push for iOS only, even when turned on', async () => {
      vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
      };
      await expect(registerNativePush()).resolves.toBe(false);
      expect(nativePlugin.requestPermissions).not.toHaveBeenCalled();
      expect(nativePlugin.register).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  // Android cannot register without google-services.json in the binary, and
  // one web bundle goes into both shells, so an iOS-only push build must say
  // nothing to Android. The bundle itself carries that answer: the Android
  // switch, not the deployment's devicePush, is what keeps the plugin unloaded.
  describe('Android needs its own build switch', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
      };
    });
    afterEach(() => vi.unstubAllEnvs());

    it('is not offered on Android without VITE_NATIVE_PUSH_ANDROID_ENABLED, whatever the deployment says', () => {
      expect(nativePushOffered({ ios: true, android: true })).toBe(false);

      vi.stubEnv('VITE_NATIVE_PUSH_ANDROID_ENABLED', 'true');
      expect(nativePushOffered({ ios: true, android: true })).toBe(true);
      expect(nativePushOffered({ ios: true, android: false })).toBe(false); // deployment still off

      // The Android switch alone turns nothing on.
      vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'false');
      expect(nativePushOffered({ ios: true, android: true })).toBe(false);
    });

    it('never loads the plugin on Android without the Android switch, even with a stored token', async () => {
      localStorage.setItem('fg.nativePush.token', 'fcm-token-old');
      await syncNativePush();
      expect(nativePlugin.checkPermissions).not.toHaveBeenCalled();
      expect(nativePlugin.register).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('registers on Android once both switches are on', async () => {
      vi.stubEnv('VITE_NATIVE_PUSH_ANDROID_ENABLED', 'true');
      nativePlugin.register.mockImplementation(async () => {
        nativePlugin.callbacks.registration?.({ value: 'fcm-token-1' });
      });

      await expect(registerNativePush()).resolves.toBe(true);

      expect(api.post).toHaveBeenCalledWith('/notifications/devices', {
        platform: 'android',
        token: 'fcm-token-1',
      });
    });

    it('does not change iOS: the first switch alone registers there', async () => {
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
      expect(nativePushOffered({ ios: true, android: false })).toBe(true);
      nativePlugin.register.mockImplementation(async () => {
        nativePlugin.callbacks.registration?.({ value: 'apns-token-1' });
      });
      await expect(registerNativePush()).resolves.toBe(true);
      expect(api.post).toHaveBeenCalledWith('/notifications/devices', {
        platform: 'ios',
        token: 'apns-token-1',
      });
    });
  });

  describe('keeping a turned-on device registered', () => {
    beforeEach(() => vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true'));
    afterEach(() => vi.unstubAllEnvs());

    it('never registers a device nobody turned on, and never asks for permission', async () => {
      await syncNativePush();
      expect(nativePlugin.requestPermissions).not.toHaveBeenCalled();
      expect(nativePlugin.register).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('sends a rotated token, and clears the badge', async () => {
      localStorage.setItem('fg.nativePush.token', 'apns-token-old');
      nativePlugin.register.mockImplementation(async () => {
        nativePlugin.callbacks.registration?.({ value: 'apns-token-new' });
      });

      await syncNativePush();

      expect(nativePlugin.requestPermissions).not.toHaveBeenCalled();
      expect(api.post).toHaveBeenCalledWith('/notifications/devices', {
        platform: 'ios',
        token: 'apns-token-new',
      });
      expect(localStorage.getItem('fg.nativePush.token')).toBe('apns-token-new');
      expect(nativePlugin.removeAllDeliveredNotifications).toHaveBeenCalledOnce();
    });

    it('removes the device server-side when the OS permission was taken away', async () => {
      localStorage.setItem('fg.nativePush.token', 'apns-token-1');
      nativePlugin.checkPermissions.mockResolvedValue({ receive: 'denied' });
      vi.mocked(api.post).mockResolvedValue({ data: { remainingSubscriptions: 0 } } as never);

      await syncNativePush();

      expect(api.post).toHaveBeenCalledWith('/notifications/devices/remove', {
        token: 'apns-token-1',
      });
      expect(nativePlugin.register).not.toHaveBeenCalled();
      expect(localStorage.getItem('fg.nativePush.token')).toBeNull();
    });
  });

  it('turning it off reports how many push endpoints the account has left', async () => {
    localStorage.setItem('fg.nativePush.token', 'apns-token-1');
    vi.mocked(api.post).mockResolvedValue({
      data: { ok: true, remainingSubscriptions: 1 },
    } as never);

    await expect(unregisterNativePush()).resolves.toBe(1);
    expect(localStorage.getItem('fg.nativePush.token')).toBeNull();
    expect(nativePlugin.unregister).toHaveBeenCalledOnce();
  });

  describe('signing out on this device', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('releases the device with no session needed, and forgets it locally at once', () => {
      localStorage.setItem('fg.nativePush.token', 'apns-token-1');

      signOutNativePush();

      expect(localStorage.getItem('fg.nativePush.token')).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/notifications\/devices\/release$/);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ token: 'apns-token-1' });
      // A bare fetch: no Authorization header, so an expired session cannot stop it.
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      expect(api.post).not.toHaveBeenCalled();
    });

    it('does nothing on a device that never turned notifications on', () => {
      signOutNativePush();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
