/**
 * WHEN in the day a daily message goes out (#343; owner decision 2026-09-17).
 *
 * Moved out of `services/reminders.ts` unchanged so a second daily sender —
 * the household chat channel (#674) — follows the same rule without importing
 * the reminder fan-out. `reminders.ts` re-exports all three names, so every
 * existing caller and test reads them from where it always did.
 *
 * The input is the three fields the rule reads, not a whole
 * `NotificationPreferences` row: a person's prefs and a channel's settings
 * both have quiet hours and a zone, and nothing else here is about a person.
 *
 * Pure: no I/O, no environment.
 */

/** The fields the delivery-time rule reads. A `NotificationPreferences` row
 *  satisfies it, and so does a household channel's settings. */
export interface QuietWindow {
  dndStart: string;
  dndEnd: string;
  timezone: string;
}

/**
 * The time of day, `HH:MM` in the recipient's zone, before which their daily
 * reminder does not go out (#343; owner decision 2026-09-17).
 *
 *   - **Quiet hours set** → when they END. A recipient with 22:00→07:00 hears
 *     at 07:00; one with 13:00→15:00 at 15:00. That is the rule as decided —
 *     "deliver when quiet hours end" — applied literally, including to a
 *     daytime window.
 *   - **No quiet hours** → `REMINDER_DEFAULT_DELIVERY_TIME`, 08:00.
 *
 * "Set" means what `notificationPrefs.isInDndWindow` means by it: both ends
 * present and different. A lone end, or a start equal to its end, is a window
 * that suppresses nothing, so it cannot move the delivery time either. An end
 * that does not parse as `HH:MM` falls back to 08:00 rather than to midnight.
 *
 * This is a floor, not an appointment. The scan is hourly, so a reminder
 * goes out on the first run at or after this time, and it still has to clear
 * quiet hours channel by channel (`eligibleReminderChannels`) — which matters
 * when the first run of a due day that finds anything lands inside a window
 * that has started again, e.g. 23:05 against 22:00→07:00. It never goes out
 * before local midnight of the due day: that is `isDueByEndOfLocalDay`.
 *
 * Wall-clock, so a DST day moves it with the clocks: 08:00 is 08:00 on the
 * day the clocks change, and a time the spring-forward skips (02:30) is
 * reached at the first run after the jump.
 */
export const REMINDER_DEFAULT_DELIVERY_TIME = '08:00';

export function reminderDeliveryTime(prefs: Pick<QuietWindow, 'dndStart' | 'dndEnd'>): string {
  const start = hhmmToMinutes(prefs.dndStart);
  const end = hhmmToMinutes(prefs.dndEnd);
  if (start === null || end === null || start === end) return REMINDER_DEFAULT_DELIVERY_TIME;
  return prefs.dndEnd;
}

/** True before the recipient's delivery time on the local day of `now`. */
export function isBeforeReminderDeliveryTime(prefs: QuietWindow, now: Date): boolean {
  const deliverAt = hhmmToMinutes(reminderDeliveryTime(prefs)) ?? 0;
  return localMinutesOfDay(now, prefs.timezone || 'UTC') < deliverAt;
}

function hhmmToMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since local midnight in `timeZone`. `h23`, so midnight is 0 and
 *  never the 24 that `hour12: false` can produce. */
function localMinutesOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return part('hour') * 60 + part('minute');
}
