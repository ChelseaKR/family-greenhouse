/**
 * Native-shell (Capacitor) platform detection.
 *
 * Deliberately reads the `window.Capacitor` global the native bridge injects
 * instead of importing `@capacitor/core`: importing the runtime would drag
 * ~6 kB (brotli) into the entry chunk for every WEB visitor to answer a
 * question that is only ever true inside the iOS/Android app binaries.
 * Features that need real plugin APIs (e.g. push registration) dynamically
 * import their plugin only after these checks pass, so the cost stays inside
 * the native-only code path.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True when running inside the iOS or Android Capacitor shell. */
export function isNativeApp(): boolean {
  return capacitorGlobal()?.isNativePlatform?.() === true;
}

/** 'ios' | 'android' inside the shells; 'web' everywhere else. */
export function getNativePlatform(): 'ios' | 'android' | 'web' {
  const platform = capacitorGlobal()?.getPlatform?.();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}
