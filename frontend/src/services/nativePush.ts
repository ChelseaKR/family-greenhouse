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

  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for a push registration token.')),
      15_000
    );
    void PushNotifications.addListener('registration', (t) => {
      clearTimeout(timer);
      resolve(t.value);
    });
    void PushNotifications.addListener('registrationError', (err) => {
      clearTimeout(timer);
      reject(new Error(err.error));
    });
    PushNotifications.register().catch((err: unknown) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  await api.post('/notifications/devices', { platform: getNativePlatform(), token });
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  return true;
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
