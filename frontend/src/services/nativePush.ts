import { api } from './api';
import { isNativeApp, getNativePlatform } from '@/lib/platform';

/**
 * Native (Capacitor iOS/Android) push. The web push path (service worker +
 * VAPID, see NotificationSettings) does not exist inside the native WebViews
 * — iOS WKWebView has no Notification/PushManager API — so the shells
 * register a device token with the backend instead (`POST
 * /notifications/devices`): a raw APNs token on iOS, which the backend sends
 * to APNs directly, and an FCM token on Android.
 *
 * ## Off until setup is done — two switches, both default off
 *
 *   1. The BUILD: `VITE_NATIVE_PUSH_ENABLED=true` in the store build's
 *      `.env.mobile.production`. Android cannot register without
 *      `google-services.json` in the binary, so a build without it must never
 *      reach this code; `scripts/validate-store-release.mjs --production`
 *      requires that file (and the iOS entitlement) once this is true, and
 *      requires the committed template to keep it false.
 *   2. The DEPLOYMENT: Terraform `native_push_enabled` plus a credential per
 *      platform, reported to the app as `devicePush` on the notification
 *      preferences. Off, or missing this platform's credential, and the app
 *      offers nothing.
 *
 * {@link nativePushOffered} is the one place both are read.
 *
 * The plugin is imported DYNAMICALLY and only after those checks: web
 * visitors never download the Capacitor runtime, keeping the entry chunk
 * inside its size-limit budget.
 */

/** This device's token, stored when the person turns notifications on here. */
const TOKEN_STORAGE_KEY = 'fg.nativePush.token';

/** When this device last re-sent its token, so a resume does not post every time. */
const SYNCED_AT_STORAGE_KEY = 'fg.nativePush.syncedAt';

/**
 * Re-send an unchanged token at most this often. Often enough that a device
 * removed with a household comes back within the day; rarely enough that a
 * resume costs nothing.
 */
const RESYNC_AFTER_MS = 6 * 60 * 60_000;

function lastSyncedAt(): number {
  try {
    return Number(localStorage.getItem(SYNCED_AT_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markSynced(): void {
  try {
    localStorage.setItem(SYNCED_AT_STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the next resume posts again, which is harmless.
  }
}

export type NativePushPermission = 'granted' | 'denied' | 'prompt';

export interface DevicePushAvailability {
  ios: boolean;
  android: boolean;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE_KEY);
    else localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage blocked: the server row is still right; the next sync repairs this.
  }
}

/** Whether this binary was built with native push (switch 1). */
export function nativePushBuildEnabled(): boolean {
  return import.meta.env.VITE_NATIVE_PUSH_ENABLED === 'true';
}

/**
 * Whether the app may offer native notifications on this device right now:
 * inside a shell, in a build that carries push, and with the deployment
 * saying this platform can be delivered to (switch 2).
 */
export function nativePushOffered(devicePush: DevicePushAvailability | undefined): boolean {
  if (!isNativeApp() || !nativePushBuildEnabled() || !devicePush) return false;
  const platform = getNativePlatform();
  return platform !== 'web' && devicePush[platform] === true;
}

/** Whether this device is registered for native notifications. */
export function isNativePushEnabled(): boolean {
  return isNativeApp() && readToken() !== null;
}

/** The OS notification permission for the app, without asking. */
export async function getNativePushPermission(): Promise<NativePushPermission> {
  if (!isNativeApp()) return 'denied';
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const status = await PushNotifications.checkPermissions();
  if (status.receive === 'granted') return 'granted';
  if (status.receive === 'denied') return 'denied';
  return 'prompt';
}

/** Register with APNs/FCM and wait for the token. The permission must already be granted. */
async function obtainToken(): Promise<string> {
  const { PushNotifications } = await import('@capacitor/push-notifications');
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
    return await tokenPromise;
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

/**
 * Ask for OS notification permission, register with APNs/FCM, and store the
 * resulting device token with the backend. This is the ONLY place the OS
 * permission prompt is raised, and it is called only from a button the
 * person tapped. Resolves true on success; throws on permission denial so the
 * caller can say how to turn it back on. No-ops (false) outside the shells.
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

  const token = await obtainToken();
  await api.post('/notifications/devices', { platform: getNativePlatform(), token });
  writeToken(token);
  markSynced();
  return true;
}

/**
 * Remove this device's token from the backend and forget it locally.
 * Resolves the push endpoints the user has left (browser subscriptions plus
 * other devices), or undefined when the server could not say.
 */
export async function unregisterNativePush(): Promise<number | undefined> {
  if (!isNativeApp()) return undefined;
  const token = readToken();
  let remaining: number | undefined;
  if (token) {
    const response = await api.post<{ remainingSubscriptions?: number }>(
      '/notifications/devices/remove',
      { token }
    );
    remaining = response.data?.remainingSubscriptions;
    writeToken(null);
  }
  const { PushNotifications } = await import('@capacitor/push-notifications');
  await PushNotifications.unregister().catch(() => undefined);
  return remaining;
}

/**
 * Signing out on this device: the server forgets this device for EVERY
 * account (so the next person to sign in here never gets the last account's
 * reminders), and the device forgets its token.
 *
 * Synchronous to start and never throws, so `authStore.logout()` can call it
 * whatever state the session is in. The request is a bare `fetch` to the
 * public `POST /notifications/devices/release`, which takes the device token
 * as its credential: a sign-out after a refused refresh has no valid session,
 * and it is exactly the sign-out that must still clean up. The local record
 * is cleared first, so nothing on this device re-registers it afterwards.
 */
export function signOutNativePush(): void {
  if (!isNativeApp()) return;
  const token = readToken();
  if (token === null) return;
  writeToken(null);
  try {
    localStorage.removeItem(SYNCED_AT_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing else to clear.
  }
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:4000';
  void fetch(`${apiUrl}/notifications/devices/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => undefined);
  void import('@capacitor/push-notifications')
    .then(({ PushNotifications }) => PushNotifications.unregister())
    .catch(() => undefined);
}

/**
 * Keep a device that is turned on registered, and clear the icon badge.
 * Called when the app starts and whenever it comes back to the foreground.
 *
 *   - Permission still granted: register again and send the token. APNs and
 *     FCM rotate tokens, and leaving a household removes the device rows
 *     registered under it; re-sending restores it under the household the
 *     person has now. No prompt is ever raised here.
 *   - Permission revoked in the OS Settings: the device can no longer show
 *     anything, so it is removed server-side too.
 *
 * Then the delivered notifications and the badge are cleared: the person is
 * looking at the app, which lists what is due.
 */
export async function syncNativePush(): Promise<void> {
  if (!isNativeApp() || !nativePushBuildEnabled()) return;
  const stored = readToken();
  if (stored === null) return;
  const permission = await getNativePushPermission();
  if (permission !== 'granted') {
    await unregisterNativePush().catch(() => writeToken(null));
    return;
  }
  // register() is cheap when nothing changed (the OS hands back the same
  // token), and on iOS it is also what lets the badge be cleared below.
  const token = await obtainToken();
  if (token !== stored || Date.now() - lastSyncedAt() > RESYNC_AFTER_MS) {
    await api.post('/notifications/devices', { platform: getNativePlatform(), token });
    writeToken(token);
    markSynced();
  }
  const { PushNotifications } = await import('@capacitor/push-notifications');
  await PushNotifications.removeAllDeliveredNotifications().catch(() => undefined);
}

/** Only this site's own links are followed from a notification tap. */
function inAppPath(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'familygreenhouse.net') return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

/**
 * Wire native push into the running app: open a tapped notification's link
 * in the app, and sync registration now and on every return to the
 * foreground. Nothing is loaded unless this is a shell built with push.
 */
export function initNativePush(): void {
  if (!isNativeApp() || !nativePushBuildEnabled()) return;

  void (async () => {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const path = inAppPath((notification.data as { url?: unknown } | undefined)?.url);
      if (!path) return;
      // Same navigation as nativeDeepLinks.ts: <BrowserRouter> re-syncs on popstate.
      window.history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    const { App } = await import('@capacitor/app');
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void syncNativePush().catch(() => undefined);
    });
    await syncNativePush().catch(() => undefined);
  })().catch((cause) => console.warn('Native push setup failed', cause));
}
