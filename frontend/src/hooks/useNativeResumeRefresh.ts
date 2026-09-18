import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isNativeApp } from '@/lib/platform';

/** Long enough that switching apps to copy a code doesn't refetch everything. */
export const RESUME_REFRESH_AFTER_MS = 60_000;

/**
 * Refresh what's on screen when the app comes back from the background.
 *
 * `refetchOnWindowFocus` is off app-wide, and a phone app is resumed far more
 * often than it is launched, so reopening the app after lunch showed the
 * morning's task list as if it were current until something else prompted a
 * read. This marks every query stale and refetches the ones on screen, once
 * the app has been away for RESUME_REFRESH_AFTER_MS.
 *
 * Native only: `@capacitor/app` is imported dynamically after the
 * isNativeApp() check, so web visitors never download it.
 */
export function useNativeResumeRefresh(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    let remove: (() => Promise<void>) | undefined;
    let backgroundedAt: number | null = null;

    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) {
            backgroundedAt = Date.now();
            return;
          }
          const away = backgroundedAt === null ? 0 : Date.now() - backgroundedAt;
          backgroundedAt = null;
          if (away >= RESUME_REFRESH_AFTER_MS) {
            void queryClient.invalidateQueries({ refetchType: 'active' });
          }
        })
      )
      .then((handle) => {
        if (cancelled) void handle.remove();
        else remove = () => handle.remove();
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      void remove?.();
    };
  }, [queryClient]);
}
