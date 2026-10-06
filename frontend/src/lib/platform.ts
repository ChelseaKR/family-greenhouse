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

/**
 * Marks `<html data-native="ios">` (or `"android"`) inside the shells, once,
 * before the first paint, so native-only CSS can key on it (index.css, "Inside
 * the native shells"). On the website it does nothing: no attribute, so not
 * one of those rules can match and the website renders exactly as before.
 */
export function markNativePlatform(): void {
  if (!isNativeApp() || typeof document === 'undefined') return;
  document.documentElement.dataset.native = getNativePlatform();
}

/** The name the iOS app's native frame registers its plugin under. */
export const NATIVE_CHROME_PLUGIN = 'NativeChrome';

/**
 * True inside the iOS app when its native frame is there: Apple's own tab bar
 * and navigation bar around the web content (ios/App/App/NativeFrame*.swift).
 * The app registers the NativeChrome plugin before the page loads, and the
 * bridge lists every registered plugin in `Capacitor.PluginHeaders` at
 * document start, so this is answered synchronously, before the first paint.
 * Never true on the website or on Android.
 */
export function hasNativeFrame(): boolean {
  if (getNativePlatform() !== 'ios') return false;
  const headers = (capacitorGlobal() as { PluginHeaders?: Array<{ name?: string }> } | undefined)
    ?.PluginHeaders;
  return Array.isArray(headers) && headers.some((h) => h?.name === NATIVE_CHROME_PLUGIN);
}

/**
 * Marks `<html data-native-frame>` when the native frame is there, once,
 * before the first paint, so the web's own chrome (header, drawer, back
 * links) is never drawn under the native bars, not even for a frame. On the
 * website it does nothing.
 */
export function markNativeFrame(): void {
  if (!hasNativeFrame() || typeof document === 'undefined') return;
  document.documentElement.dataset.nativeFrame = '';
}

/**
 * True inside the iOS app when its native frame can show Apple's own alerts
 * and action sheets for the web (NativeChrome's `present`): confirmations
 * and choices then open as UIAlertController, over the native bars, instead
 * of a web dialog between them. Read from the plugin's own method list, so
 * it is answered before the first paint. Never true on the website.
 */
export function hasNativePresent(): boolean {
  return hasNativeChromeMethod('present');
}

/**
 * True inside the iOS app when a web form can be drawn as a native sheet
 * (NativeChrome's `presentForm`): Add care task then opens as one. An app
 * built before the method existed answers false and keeps the web dialog.
 * Never true on the website.
 */
export function hasNativeFormSheet(): boolean {
  return hasNativeChromeMethod('presentForm');
}

/**
 * True inside the iOS app when the navigation bar can carry a screen's own
 * menus and search field (NativeChrome's `setBarTools`): the Plants list
 * then puts its Filter and More menus and its search in the native bar
 * instead of a row of web controls. An app built before the method existed
 * answers false and keeps the web row. Never true on the website.
 */
export function hasNativeBarTools(): boolean {
  return hasNativeChromeMethod('setBarTools');
}

/** Whether the app's NativeChrome plugin lists `method`, from its header. */
function hasNativeChromeMethod(method: string): boolean {
  if (!hasNativeFrame()) return false;
  const headers = (
    capacitorGlobal() as
      { PluginHeaders?: Array<{ name?: string; methods?: Array<{ name?: string }> }> } | undefined
  )?.PluginHeaders;
  const chrome = headers?.find((h) => h?.name === NATIVE_CHROME_PLUGIN);
  return Array.isArray(chrome?.methods) && chrome.methods.some((m) => m?.name === method);
}

/**
 * For the checkbox of a true on/off setting (one that saves the moment it
 * changes): inside the iOS app's native frame it becomes `role="switch"`,
 * which index.css draws as an iOS switch and VoiceOver reads as "switch, on".
 * It stays the same `<input type="checkbox">`, with the same `checked` and
 * `onChange`, so it writes exactly what it wrote before. On the website it
 * adds nothing.
 */
export function nativeSwitchRole(): { role?: 'switch' } {
  return hasNativeFrame() ? { role: 'switch' } : {};
}
