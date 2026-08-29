import type { notificationService } from '@/services/notificationService';
import type { NotificationPreferences } from '@/services/notificationService';

export type PreferencesUpdate = Parameters<typeof notificationService.updatePreferences>[0];

/** The browser's IANA zone, or 'UTC' where Intl is unavailable or throws. */
export function resolveBrowserTimeZone(): string {
  try {
    return typeof Intl !== 'undefined'
      ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
      : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Build the full preferences payload for a save.
 *
 * Every save sends all fields, so a partial payload cannot accidentally
 * re-enable a channel the user turned off in another session.
 *
 * `resolvedTimeZone` (the browser's own zone) is sent whenever the server has
 * never recorded a zone for this user. This used to pass `current.timezone`
 * through unconditionally, and the quiet-hours Save was the ONLY control in
 * the app that ever wrote the field — so a user who never opened quiet hours
 * stayed `'UTC'` forever, while the reminder dedupe key, the ICS feed and the
 * weekly digest all keyed off that zone and quietly treated them as being in
 * London (#342).
 *
 * `current.timezoneSet` is what makes this safe rather than a guess: it is
 * server-derived from whether the attribute actually exists on the row, so a
 * deliberately chosen `'UTC'` is distinguishable from the never-set default
 * and is never overwritten. An explicit `timezone` in `overrides` (the
 * quiet-hours panel) still wins over both.
 */
export function buildPreferencesUpdate(
  current: NotificationPreferences,
  overrides: Partial<PreferencesUpdate>,
  resolvedTimeZone: string
): PreferencesUpdate {
  return {
    browser: current.browser,
    email: current.email,
    sms: current.sms,
    phone: current.phone,
    dndStart: current.dndStart,
    dndEnd: current.dndEnd,
    timezone: current.timezoneSet ? current.timezone : resolvedTimeZone,
    pestAlerts: current.pestAlerts ?? false,
    weeklyDigest: current.weeklyDigest ?? true,
    ...overrides,
  };
}
