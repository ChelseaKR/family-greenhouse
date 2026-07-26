import { api } from './api';
import { isNativeApp, getNativePlatform } from '@/lib/platform';

/**
 * Native (Capacitor iOS/Android) push registration. The web push path
 * (service worker + VAPID, see NotificationSettings) does not exist inside
 * the native WebViews — iOS WKWebView has no Notification/PushManager API —
 * so the shells register an APNs/FCM device token with the backend instead
 * (`POST /notifications/devices`).
 *
 * The plugin is imported DYNAMICALLY and only after an isNativeApp() check:
 * web visitors never download the Capacitor runtime, keeping the entry chunk
 * inside its size-limit budget. Delivery is a backend follow-up (the APNs/FCM
 * sender needs Apple/Firebase credentials — docs/mobile.md); registering
 * tokens from the first shipped build means the sender covers existing
 * installs the day it lands.
 */

/** Mirrors fg.notifications.enabled for the native channel. */
const TOKEN_STORAGE_KEY = 'fg.nativePush.token';

export function isNativePushEnabled(): boolean {
  return isNativeApp() && localStorage.getItem(TOKEN_STORAGE_KEY) !== null;
}

/**
 * Ask for OS notification permission, register with APNs/FCM, and store the
 * resulting device token with the backend. Resolves true on success; throws
 * on permission denial so the caller can surface the same error UX as the
 * web flow. No-ops (false) outside the native shells.
 */
export async function registerNativePush(): Promise<boolean> {
  if (!isNativeApp()) return false;
  const { PushNotifications } = await import('@capacitor/push-notifications');

  let status = await PushNotifications.checkPermissions();
  if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
    status = await PushNotifications.requestPermissions();
  }
  if (status.receive !== 'granted') {
    throw new Error('Notification permission was denied. Update your device settings to enable.');
  }

  let resolveToken!: (token: string) => void;
  let rejectToken!: (cause: Error) => void;
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });
  const listenerHandles: Array<{ remove: () => Promise<void> }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Capacitor's listener registration is asynchronous. Await both handles
    // before calling register(); otherwise a fast APNs/FCM callback can fire
    // before JavaScript has attached its receiver and leave the UI hanging
    // until the timeout.
    listenerHandles.push(
      await PushNotifications.addListener('registration', (token) => {
        if (timer) clearTimeout(timer);
        resolveToken(token.value);
      })
    );
    listenerHandles.push(
      await PushNotifications.addListener('registrationError', (error) => {
        if (timer) clearTimeout(timer);
        rejectToken(new Error(error.error));
      })
    );
    timer = setTimeout(
      () => rejectToken(new Error('Timed out waiting for a push registration token.')),
      15_000
    );
    await PushNotifications.register();
    const token = await tokenPromise;

    await api.post('/notifications/devices', { platform: getNativePlatform(), token });
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    return true;
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.all(
      listenerHandles.map((handle) =>
        handle.remove().catch((cause) => {
          console.warn('Native push listener cleanup failed', cause);
        })
      )
    );
  }
}

/** Remove this device's token from the backend and forget it locally. */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativeApp()) return;
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) {
    await api.post('/notifications/devices/remove', { token });
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  const { PushNotifications } = await import('@capacitor/push-notifications');
  await PushNotifications.unregister();
}
