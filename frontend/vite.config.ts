import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'brand/favicon.ico',
        'brand/favicon-32x32.png',
        'brand/icon.svg',
        'brand/apple-touch-icon.png',
        'robots.txt',
      ],
      manifest: {
        name: 'Family Greenhouse',
        short_name: 'Greenhouse',
        description: 'A collaborative plant care app for families. Grow together.',
        // Per brand guidelines: Leaf Mid (#639922) for theme color,
        // Greenhouse (#EAF3DE) for the splash background.
        theme_color: '#639922',
        background_color: '#EAF3DE',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Maskable variant: the on-green plate gives Android safe-zone
          // padding so the icon doesn't get clipped by aggressive home-
          // screen masks.
          {
            src: '/brand/icon-512-on-green.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Take over as soon as the new SW installs instead of waiting for
        // every tab to close. Without this, a deploy can leave users on a
        // stale bundle indefinitely — and a mismatched bundle vs persisted
        // store can break the login flow entirely.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Cache only the app shell; don't cache API responses (the data is
        // collaborative, stale reads are confusing).
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|webp)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images',
              expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@/components': resolve(__dirname, './src/components'),
      '@/features': resolve(__dirname, './src/features'),
      '@/hooks': resolve(__dirname, './src/hooks'),
      '@/services': resolve(__dirname, './src/services'),
      '@/store': resolve(__dirname, './src/store'),
      '@/utils': resolve(__dirname, './src/utils'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  preview: {
    port: 3000,
  },
  build: {
    sourcemap: true,
    // CQ-19: explicit chunk-size warning (500 KB) as a build-time signal
    // separate from the hard size-limit CI gate (`npm run size`), and pin the
    // build target to Baseline "Widely available" (evergreen browsers with
    // broad real-world support) instead of trusting Vite's implicit default —
    // an explicit, reviewable choice rather than an unstated one.
    chunkSizeWarningLimit: 500,
    target: 'baseline-widely-available',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep the React runtime in a single long-lived vendor chunk.
          // A string-array manualChunks entry (['react', 'react-dom', ...])
          // stopped capturing all of react-dom's submodules under React 19,
          // which leaked the runtime into the entry chunk and ballooned it.
          // Matching on the resolved node_modules path is version-robust.
          if (
            /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)
          ) {
            return 'vendor';
          }
          if (/node_modules\/@tanstack\/react-query\//.test(id)) {
            return 'query';
          }
          if (/node_modules\/(@headlessui\/react|@heroicons\/react)\//.test(id)) {
            return 'ui';
          }
          return undefined;
        },
      },
    },
  },
});
