import { isNativeApp } from '@/lib/platform';

/**
 * Launch screen and status bar inside the iOS/Android shells.
 *
 * LAUNCH. Without this, a cold start went: launch screen, then a blank
 * WebView (white in light mode, black in dark mode) for as long as the
 * bundle took to parse and the first route to load, and for a signed-in
 * user a glimpse of the prerendered marketing page the binary carries as
 * `index.html` before React replaced it. Measured on an iPhone 17 Pro
 * simulator: about 2.75 s of blank on a warm launch. `capacitor.config.ts`
 * now keeps the launch screen up (`SplashScreen.launchAutoHide: false`) and
 * this module takes it down once the first page has actually rendered
 * (`markNativeAppReady`, called from App.tsx, waits for a page heading), so
 * the launch screen fades straight into the app.
 *
 * A launch screen held by JavaScript is a launch screen JavaScript can fail
 * to release, and a frozen splash reads as a hung app. So
 * `armNativeSplashFallback` runs from `nativeLaunchBoot.ts`, the second
 * module main.tsx evaluates, before any application module body can throw,
 * and releases it after SPLASH_FALLBACK_MS whatever else happened.
 *
 * STATUS BAR. The app has no dark theme (main.tsx: dark mode was removed
 * until components get real dark variants), so the status bar has to follow
 * the surface behind it, not the system appearance. Following the system put
 * light icons on the light app header in dark mode on Android. The launch
 * screen is forest green, so the bar starts light-on-dark
 * (`SystemBars.style: 'DARK'` in the config) and switches to dark-on-light
 * as the splash goes. The one dark surface in the app that reaches under the
 * status bar is the navigation drawer, and Layout.tsx flips the bar for it.
 *
 * Both plugins are imported dynamically after an isNativeApp() check, like
 * nativePush.ts, so web visitors never download them.
 */

/** Long enough for a slow cold start; short enough that a failure isn't a hang. */
export const SPLASH_FALLBACK_MS = 5000;

let splashReleased = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

async function setStatusBarContent(content: 'light' | 'dark'): Promise<void> {
  const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
  // SystemBarsStyle names the BACKGROUND: `Dark` = light content for a dark
  // surface, `Light` = dark content for a light one.
  await SystemBars.setStyle({
    style: content === 'light' ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
  });
}

async function releaseSplash(): Promise<void> {
  const { SplashScreen } = await import('@capacitor/splash-screen');
  // The status bar changes first, so it is never light-on-paper while the
  // splash fades, and again once it has gone: Android's splash screen exit
  // reapplies the theme's bar appearance over whatever was set before it.
  await setStatusBarContent('dark').catch(() => undefined);
  await SplashScreen.hide({ fadeOutDuration: 200 });
  await setStatusBarContent('dark').catch(() => undefined);
}

/**
 * What "the first route has rendered" means: a page heading is on screen.
 * The first route to commit is often a redirect that renders nothing (`/`
 * for a signed-in user is HomeRedirect, which navigates to /dashboard inside
 * a transition while the dashboard chunk loads), so the commit alone would
 * fade the splash into a blank page. Every page the shells open on has an
 * h1; one that doesn't still gets the fallback.
 */
export const FIRST_SCREEN_SELECTOR = '#main-content h1';

function release(): void {
  splashReleased = true;
  if (fallbackTimer) clearTimeout(fallbackTimer);
  // Two frames: the first lets the page lay out, the second is the one it
  // paints in, so the fade never reveals a half-drawn screen.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void releaseSplash().catch(() => undefined);
    })
  );
}

let waitingForFirstScreen: MutationObserver | undefined;

/**
 * Called once the first route has committed (NativeLaunchReady). Releases the
 * launch screen as soon as a page heading is on screen. Idempotent; a no-op
 * on the web.
 */
export function markNativeAppReady(): void {
  if (!isNativeApp() || splashReleased || waitingForFirstScreen) return;
  if (document.querySelector(FIRST_SCREEN_SELECTOR)) {
    release();
    return;
  }
  const observer = new MutationObserver(() => {
    if (splashReleased || document.querySelector(FIRST_SCREEN_SELECTOR)) {
      observer.disconnect();
      waitingForFirstScreen = undefined;
      if (!splashReleased) release();
    }
  });
  waitingForFirstScreen = observer;
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Releases the launch screen after SPLASH_FALLBACK_MS if nothing else has. */
export function armNativeSplashFallback(): void {
  if (!isNativeApp() || fallbackTimer) return;
  fallbackTimer = setTimeout(() => {
    if (splashReleased) return;
    waitingForFirstScreen?.disconnect();
    waitingForFirstScreen = undefined;
    splashReleased = true;
    void releaseSplash().catch(() => undefined);
  }, SPLASH_FALLBACK_MS);
}

/**
 * Does the page draw under the status bar? True on iOS (viewport-fit=cover)
 * and on Android when Capacitor passes the insets through to a WebView new
 * enough to report them (140+). False on older Android WebViews, where
 * Capacitor pads the WebView below the bar instead and the bar sits on the
 * window background, not on anything the page drew.
 */
function pageDrawsUnderStatusBar(): boolean {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)';
  document.body.appendChild(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return inset > 0;
}

/**
 * Light status bar content while a dark surface (the navigation drawer) is
 * under it, dark content otherwise. A no-op on the web and wherever the page
 * does not reach under the bar.
 */
export function setNativeStatusBarOverDarkSurface(dark: boolean): void {
  if (!isNativeApp() || !pageDrawsUnderStatusBar()) return;
  void setStatusBarContent(dark ? 'light' : 'dark').catch(() => undefined);
}

/**
 * KEYBOARD. @capacitor/keyboard shrinks the iOS WebView above the keyboard,
 * and Capacitor pads the Android one by the IME inset, so the sticky header
 * stays put. What neither does is bring the focused field back into view
 * once the WebView is shorter: measured on the simulator, focusing the add-
 * plant notes field left it at 523-637 px in a WebView now 539 px tall, under
 * the keyboard. So when the WebView shrinks while a field has focus, scroll
 * that field to the middle of what is left.
 */
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

export function initNativeKeyboardScroll(): void {
  if (!isNativeApp()) return;
  let lastHeight = window.innerHeight;
  window.addEventListener('resize', () => {
    const shrank = window.innerHeight < lastHeight;
    lastHeight = window.innerHeight;
    const field = document.activeElement;
    if (!shrank || !(field instanceof HTMLElement) || !field.matches(FIELD_SELECTOR)) return;
    requestAnimationFrame(() => field.scrollIntoView({ block: 'center', inline: 'nearest' }));
  });
}

/** Test seam: forget the module-level launch state between tests. */
export function resetNativeShellForTests(): void {
  splashReleased = false;
  waitingForFirstScreen?.disconnect();
  waitingForFirstScreen = undefined;
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
}
