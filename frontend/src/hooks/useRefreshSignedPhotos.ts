import { useCallback, useContext, type SyntheticEvent } from 'react';
import { QueryClientContext } from '@tanstack/react-query';

/** At most one refresh this often, however many photos fail at once. */
export const SIGNED_PHOTO_REFRESH_INTERVAL_MS = 60_000;

let lastRefreshAt = Number.NEGATIVE_INFINITY;

/** Test seam: forget the last refresh so each test starts unthrottled. */
export function __resetSignedPhotoRefreshForTests(): void {
  lastRefreshAt = Number.NEGATIVE_INFINITY;
}

/**
 * True when `src` is a signed photo URL: one that carries its own signature,
 * and so its own expiry. Plant photos are served only this way (ADR 0033).
 */
export function isSignedPhotoUrl(src: string): boolean {
  try {
    return new URL(src).searchParams.has('X-Amz-Signature');
  } catch {
    return false;
  }
}

/**
 * An `onError` handler for a plant photo. A signed photo URL expires on its
 * own, usually after an hour or so, and a page left open longer than that
 * still holds the old one — a lazily loaded photo scrolled into view then
 * fails. When a signed photo fails to load, this refetches what is on screen,
 * which brings fresh URLs with it.
 *
 * Any failure of a signed URL counts, not only a past expiry: the signing
 * credentials can end before the date the URL states. Throttled, so a photo
 * that is genuinely missing costs one refetch a minute at most, and only
 * while it is on screen.
 *
 * Read from the context rather than `useQueryClient()`, which throws outside
 * a provider: a photo can be drawn where no query produced it, and there it
 * simply has nothing to refresh.
 */
export function useRefreshSignedPhotos(): (event: SyntheticEvent<HTMLImageElement>) => void {
  const queryClient = useContext(QueryClientContext);
  return useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      if (!queryClient) return;
      const image = event.currentTarget;
      const src = image.currentSrc || image.src;
      if (!src || !isSignedPhotoUrl(src)) return;
      const now = Date.now();
      if (now - lastRefreshAt < SIGNED_PHOTO_REFRESH_INTERVAL_MS) return;
      lastRefreshAt = now;
      void queryClient.invalidateQueries({ refetchType: 'active' });
    },
    [queryClient]
  );
}
