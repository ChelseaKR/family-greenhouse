import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  },
}));

import { api } from '@/services/api';
import { registerNativePush } from '@/services/nativePush';

describe('native push registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePlugin.callbacks = {};
    localStorage.clear();
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
    nativePlugin.removeRegistrationError.mockResolvedValue(undefined);
    vi.mocked(api.post).mockResolvedValue({} as never);
  });

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
});
