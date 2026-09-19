import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import {
  buildPreferencesUpdate,
  notificationService,
  type NotificationPreferences,
} from '@/services/notificationService';
import {
  getNativePushPermission,
  isNativePushEnabled,
  nativePushOffered,
  registerNativePush,
  unregisterNativePush,
  type NativePushPermission,
} from '@/services/nativePush';
import { isNativeApp } from '@/lib/platform';

/**
 * Native push on this phone, for the settings row and the opt-in card.
 *
 * `offered` is false everywhere except a shell built with push whose
 * deployment can deliver to its platform (see nativePush.ts), so callers can
 * render nothing without further checks.
 *
 * Turning it on is the only path to the OS permission prompt, and it runs
 * only from a tap. It registers the device, then makes sure the account-wide
 * `browser` preference (one channel, two transports — see notifier.ts) is on.
 * Turning it off removes this device, and switches the preference off only
 * when the server says no other device or browser is left, so switching off
 * the phone never silences the laptop.
 */
export function useNativePush() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const native = isNativeApp();
  const prefsKey = ['notification-prefs', householdId] as const;

  const prefsQuery = useQuery({
    queryKey: prefsKey,
    queryFn: notificationService.getPreferences,
    enabled: native && Boolean(householdId),
  });
  const offered = nativePushOffered(prefsQuery.data?.devicePush);

  const [enabled, setEnabled] = useState(isNativePushEnabled);
  const [permission, setPermission] = useState<NativePushPermission | null>(null);

  const refreshPermission = useCallback(() => {
    if (!offered) return;
    void getNativePushPermission()
      .then(setPermission)
      .catch(() => setPermission(null));
  }, [offered]);
  useEffect(refreshPermission, [refreshPermission]);

  const scope = { id: `notification-preferences:${householdId ?? 'none'}` };

  function current(): NotificationPreferences | undefined {
    return queryClient.getQueryData<NotificationPreferences>(prefsKey) ?? prefsQuery.data;
  }

  const enable = useMutation({
    scope,
    mutationFn: async () => {
      const prefs = current();
      if (!prefs) throw new Error(t('notifications.preferencesUnavailable'));
      try {
        await registerNativePush();
      } catch (cause) {
        refreshPermission();
        const now = await getNativePushPermission().catch(() => null);
        if (now === 'denied') throw new Error(t('nativePush.deniedError'), { cause });
        throw cause;
      }
      if (prefs.browser) return prefs;
      try {
        return await notificationService.updatePreferences(
          buildPreferencesUpdate(prefs, { browser: true })
        );
      } catch (cause) {
        // Never leave a registered device behind a preference that says off.
        await unregisterNativePush().catch(() => undefined);
        throw cause;
      }
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(prefsKey, updated);
      setEnabled(true);
      refreshPermission();
    },
  });

  const disable = useMutation({
    scope,
    mutationFn: async () => {
      const prefs = current();
      const remaining = await unregisterNativePush();
      if (prefs && prefs.browser && remaining === 0) {
        return await notificationService.updatePreferences(
          buildPreferencesUpdate(prefs, { browser: false })
        );
      }
      return prefs;
    },
    onSuccess: (updated) => {
      if (updated) queryClient.setQueryData(prefsKey, updated);
      setEnabled(false);
    },
  });

  return { offered, enabled, permission, enable, disable, refreshPermission };
}
