import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import {
  buildPreferencesUpdate,
  notificationService,
  type NotificationPreferences,
} from '@/services/notificationService';
import { resolveBrowserTimeZone } from '@/utils/timeZone';

/** Zones equivalent to the server's UTC default; sending one changes nothing. */
const UTC_ALIASES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal']);

/** Users this page load has already tried for, so a remount never re-sends. */
const attempted = new Set<string>();

/** Test seam: forget which users this page load has tried. */
export function __resetDetectedTimeZoneForTests(): void {
  attempted.clear();
}

/**
 * Whether the stored zone is still unset: never chosen, and still the server
 * default. Older servers send no `timezoneChosen`, which reads as not chosen,
 * the same rule the server applies to rows written before the flag existed.
 */
export function isTimeZoneUnset(
  prefs: Pick<NotificationPreferences, 'timezone' | 'timezoneChosen'>
): boolean {
  return prefs.timezoneChosen !== true && (prefs.timezone === '' || prefs.timezone === 'UTC');
}

/**
 * Save this browser's IANA zone as the member's notification zone, once per
 * page load, while it is still unset.
 *
 * Reminders, quiet hours and the calendar feed are all read in that zone. It
 * used to be saved only when someone opened Settings, Notifications, so a
 * member who never did got 08:00 UTC reminders (about 3-4 a.m. Eastern) and
 * feed dates a day late. Mounted in `Layout`, so it runs on sign-in and on
 * every app load for a signed-in member.
 *
 * The write is `timezoneSource: 'detected'`: the server applies the zone only
 * if it is still unset and changes no other field
 * (`notificationPrefs.applyDetectedTimeZone`). The check here only saves a
 * request; the server makes the decision. A zone the member chose, UTC
 * included, is never overwritten.
 *
 * Best effort. A browser that cannot name its zone, or one that reports UTC,
 * sends nothing, and a failed request is retried on the next page load rather
 * than in a loop.
 */
export function useDetectedTimeZone(): void {
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const householdId = useActiveHouseholdId();

  useEffect(() => {
    if (!userId || !householdId || attempted.has(userId)) return;
    const zone = resolveBrowserTimeZone();
    if (zone === null || UTC_ALIASES.has(zone)) return;
    attempted.add(userId);

    // Same key the settings page reads, so both share one cached record.
    const prefsKey = ['notification-prefs', householdId] as const;
    void (async () => {
      try {
        const current = await queryClient.fetchQuery({
          queryKey: prefsKey,
          queryFn: notificationService.getPreferences,
          staleTime: 30_000,
        });
        if (!isTimeZoneUnset(current)) return;
        const updated = await notificationService.updatePreferences({
          ...buildPreferencesUpdate(current, { timezone: zone }),
          timezoneSource: 'detected',
        });
        queryClient.setQueryData(prefsKey, updated);
      } catch {
        // Nothing to show: the member did not ask for this write. The next
        // page load tries again.
      }
    })();
  }, [queryClient, userId, householdId]);
}
