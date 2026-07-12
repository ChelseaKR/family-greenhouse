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
  plugins: {
    PushNotifications: {
      // Show reminders even while the app is foregrounded — a watering
      // reminder that silently vanishes because the app happened to be open
      // defeats the point.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
