import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native-shell (iOS/Android) configuration. The mobile apps are the SAME
 * built web bundle (`dist/`) wrapped in a Capacitor WebView — build with
 * production env vars (VITE_API_URL etc.) before `npx cap sync`, because the
 * bundle is baked into the binary at build time; web deploys do NOT update
 * shipped apps. Full build/release flow: docs/mobile.md.
 */
const config: CapacitorConfig = {
  appId: 'net.familygreenhouse.app',
  appName: 'Family Greenhouse',
  webDir: 'dist',
  // The WebView's own color while the bundle loads: the forest green of the
  // launch screen and of `html` in index.css, instead of the platform default
  // (white, or black in dark mode) flashing between the two.
  backgroundColor: '#173404',
  plugins: {
    SplashScreen: {
      // Held until the first route renders; src/services/nativeShell.ts
      // releases it, with a timed fallback armed by src/nativeLaunchBoot.ts
      // so a startup failure can never leave the splash up.
      launchAutoHide: false,
      launchFadeOutDuration: 200,
      backgroundColor: '#173404',
      showSpinner: false,
    },
    SystemBars: {
      // Light icons over the forest launch screen. nativeShell.ts switches to
      // dark icons as the splash goes, because the app itself is always light
      // (it has no dark theme), whatever the system appearance.
      style: 'DARK',
    },
    // @capacitor/keyboard needs no settings: installing it is the change. Its
    // default iOS resize mode, `native`, shrinks the WebView above the
    // keyboard instead of letting the keyboard cover the page and scroll it.
    // Without the plugin the sticky header scrolled off and page text ran
    // under the status bar while typing, and position:fixed dialogs were laid
    // out against a viewport the keyboard covered. Android needs nothing
    // either: Capacitor's SystemBars already pads the WebView by the IME inset.
    // The keyboard's appearance follows UIUserInterfaceStyle (Info.plist).
    Keyboard: {},
    CapacitorHttp: {
      // Route fetch/XMLHttpRequest through URLSession (iOS) / the native HTTP
      // stack (Android). API Gateway's managed CORS must stay enabled for web
      // clients so gateway-generated JWT 401s remain readable, but it cannot
      // represent iOS's capacitor:// origin. Native transport avoids that
      // WebView boundary and also covers presigned S3 image-upload PUTs.
      enabled: true,
    },
    PushNotifications: {
      // Show reminders even while the app is foregrounded — a watering
      // reminder that silently vanishes because the app happened to be open
      // defeats the point.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
