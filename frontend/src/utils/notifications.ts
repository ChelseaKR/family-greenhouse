// Light wrapper around the Notification API. We persist the user's "I want
// reminders" choice in localStorage so we can quietly skip prompting on
// subsequent loads, and we expose a single `notify` helper that no-ops when
// permission isn't granted.

const STORAGE_KEY = 'fg.notifications.enabled';

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getPermission(): NotificationPermission | 'unsupported' {
  if (!isSupported()) return 'unsupported';
  return Notification.permission;
}

export function isEnabledLocally(): boolean {
  if (!isSupported()) return false;
  return localStorage.getItem(STORAGE_KEY) === '1' && Notification.permission === 'granted';
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isSupported()) return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    localStorage.setItem(STORAGE_KEY, '1');
  }
  return result;
}

export function disableLocally(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Show a browser notification. Returns `true` only when the Notification was
 * actually constructed; `false` when notifications are off locally OR the
 * browser rejected construction. Callers that remember "already told the
 * user" must key off this, not off having called it: a swallowed constructor
 * throw used to be recorded as delivered, and the task was never announced
 * again that session.
 */
export function notify(title: string, options?: NotificationOptions): boolean {
  if (!isEnabledLocally()) return false;
  try {
    new Notification(title, {
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-192.png',
      ...options,
    });
    return true;
  } catch {
    // Some browsers reject Notification construction (e.g. on iOS standalone
    // PWA without explicit permission) — silently swallow rather than blow up.
    return false;
  }
}
