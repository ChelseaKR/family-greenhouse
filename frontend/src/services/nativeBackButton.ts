import { getNativePlatform, isNativeApp } from '@/lib/platform';

/**
 * Android back inside the shell: see nativeBackButtonHandler.ts for what it
 * does and why. This is the only part in the entry chunk, so web visitors
 * download neither the handler nor `@capacitor/app`.
 */
export function initNativeBackButton(): void {
  if (!isNativeApp() || getNativePlatform() !== 'android') return;
  void import('./nativeBackButtonHandler')
    .then(({ installNativeBackButton }) => installNativeBackButton())
    .catch(() => undefined);
}
