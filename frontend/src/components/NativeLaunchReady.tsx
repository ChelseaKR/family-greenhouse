import { useEffect } from 'react';
import { markNativeAppReady } from '@/services/nativeShell';

/**
 * Renders nothing. App.tsx mounts it inside the route Suspense boundary, so
 * its effect runs only after the first route's chunk has resolved and the
 * route has committed. That is the moment the native launch screen comes
 * down (services/nativeShell.ts), rather than on the loading spinner.
 */
export function NativeLaunchReady() {
  useEffect(() => {
    markNativeAppReady();
  }, []);
  return null;
}
