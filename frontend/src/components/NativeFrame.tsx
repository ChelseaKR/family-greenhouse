import { Suspense, lazy } from 'react';
import { hasNativeFrame } from '@/lib/platform';

const NativeFrameBridge = lazy(() => import('./NativeFrameBridge'));

/**
 * The web half of the iOS app's native frame (NativeFrameBridge.tsx). Renders
 * nothing anywhere else, and its code is its own chunk, so the website neither
 * runs nor downloads it.
 */
export function NativeFrame() {
  if (!hasNativeFrame()) return null;
  return (
    <Suspense fallback={null}>
      <NativeFrameBridge />
    </Suspense>
  );
}
