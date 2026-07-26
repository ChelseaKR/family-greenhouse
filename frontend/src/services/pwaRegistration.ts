import { registerSW } from 'virtual:pwa-register';

/**
 * Register the generated worker through vite-plugin-pwa's guarded runtime.
 * Its error callback consumes navigation-time Abort/InvalidState failures
 * that the plugin's bare generated registerSW.js would otherwise leave as
 * unhandled page errors in Firefox.
 */
export function initPwaRegistration(): void {
  if (!('serviceWorker' in navigator)) return;

  registerSW({
    immediate: true,
    onRegisterError(error) {
      console.warn('Service worker registration failed', error);
    },
  });
}
