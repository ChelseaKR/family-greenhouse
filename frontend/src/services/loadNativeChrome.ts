/**
 * The NativeChrome plugin module, loaded on demand. Website code that may run
 * inside the iOS app calls this only after a `hasNative…()` check, so the
 * website never downloads the plugin chunk.
 *
 * It resolves to the MODULE, never to the plugin itself: the plugin is a
 * Capacitor proxy that answers every property, `then` included, so a promise
 * resolved with it calls `NativeChrome.then()` on the app and rejects
 * ('"NativeChrome.then()" is not implemented on ios'). Seen in the simulator.
 */
export function loadNativeChrome(): Promise<typeof import('./nativeChrome')> {
  return import('./nativeChrome');
}
