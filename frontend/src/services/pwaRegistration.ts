import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from '@/lib/platform';

/** The caches the generated worker creates: Workbox's precache and `images`. */
function isWorkerCache(name: string): boolean {
  return name.startsWith('workbox-') || name === 'images';
}

/**
 * Inside the iOS/Android shells there is no worker to register, and any
 * worker an earlier build left behind is removed along with its caches.
 *
 * iOS never had one: the shell is served from `capacitor://localhost`, a
 * custom scheme where service workers are unavailable, so registration
 * failed into the warning below on every launch. Android did. Its shell is
 * served from `https://localhost`, so the worker registered and precached the
 * whole build, 148 files and about 3.3 MB (measured on an API 36 emulator),
 * copying assets that are already inside the APK. The worker then answered
 * every launch from that copy, so the first launch after a store update ran
 * the PREVIOUS build until the new worker took over and reloaded the page. In
 * other words the old app was shown as the current one, and paid a precache
 * of the new one on the way.
 *
 * The app starts from files in the binary either way, so dropping the worker
 * loses nothing offline (docs/mobile.md, "Offline").
 */
async function retireNativeServiceWorkers(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  if (typeof caches !== 'undefined') {
    const names = await caches.keys();
    await Promise.all(names.filter(isWorkerCache).map((name) => caches.delete(name)));
  }
}

/**
 * Register the generated worker through vite-plugin-pwa's guarded runtime.
 * Its error callback consumes navigation-time Abort/InvalidState failures
 * that the plugin's bare generated registerSW.js would otherwise leave as
 * unhandled page errors in Firefox.
 */
export function initPwaRegistration(): void {
  if (!('serviceWorker' in navigator)) return;

  if (isNativeApp()) {
    void retireNativeServiceWorkers().catch(() => undefined);
    return;
  }

  registerSW({
    immediate: true,
    onRegisterError(error) {
      console.warn('Service worker registration failed', error);
    },
  });
}
