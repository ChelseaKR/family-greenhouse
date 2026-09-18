import { Suspense, lazy } from 'react';
import { isNativeApp } from '@/lib/platform';

const PullToRefreshGesture = lazy(() => import('./PullToRefreshGesture'));

/**
 * Pull to refresh, inside the native shells only (PullToRefreshGesture.tsx).
 * The gesture code is its own chunk, so the website neither runs nor
 * downloads it.
 */
export function PullToRefresh() {
  if (!isNativeApp()) return null;
  return (
    <Suspense fallback={null}>
      <PullToRefreshGesture />
    </Suspense>
  );
}
