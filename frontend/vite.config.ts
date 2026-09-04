import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

import { manualChunks } from './vite.manualChunks';

/**
 * Strip HTML comments, repeatedly, until the output stops changing.
 *
 * One `replace` pass is not enough, and CodeQL is right to flag it
 * (js/incomplete-multi-character-sanitization). Two ways a `<!--` survives a
 * single pass, both measured rather than assumed:
 *
 *   1. Removing a comment can JUXTAPOSE the text on either side into a new one.
 *      `<!-<!-- x -->-a-->` loses `<!-- x -->` and the remains close up into
 *      `<!--a-->` — a comment that was not in the input and is still there when
 *      the single pass ends. Looping to a fixpoint removes what the previous
 *      pass created.
 *   2. An UNTERMINATED `<!--` matches nothing, so no number of passes removes
 *      it. Shipping it would comment out every byte after it, silently
 *      truncating the served document. That is what the assertion below
 *      refuses: the build fails instead of emitting a half-swallowed page.
 *
 * `head:start` / `head:end` are exempt: scripts/prerender.mjs needs those two
 * markers in dist/index.html to splice each route's <head> in, and consumes
 * them there — they never reach a served page.
 */
const COMMENTS = /<!--(?!head:start|head:end)[\s\S]*?-->\s*/g;

function stripHtmlComments(html: string): string {
  let out = html;
  let previous;
  do {
    previous = out;
    out = out.replace(COMMENTS, '');
  } while (out !== previous);

  const leftover = out.replace(/<!--head:(?:start|end)-->/g, '');
  if (leftover.includes('<!--')) {
    throw new Error(
      'api-origin: an unterminated HTML comment survived stripping. Refusing to ' +
        'emit a document whose markup a stray `<!--` could truncate.'
    );
  }
  return out;
}

/**
 * Substitute `__API_ORIGIN__` in index.html with the origin of VITE_API_URL.
 *
 * index.html used to hardcode `http://localhost:4000` in the preconnect hint
 * and in the CSP's img-src/connect-src. That is correct for `npm run dev`, but
 * it shipped verbatim to production, where the preconnect opened a connection
 * to a host that doesn't exist and the CSP carried a dead localhost origin.
 * Resolving it from the same env var the API client reads keeps dev and the
 * local production-bundle e2e run working (unset → localhost) while a deployed
 * build, which sets VITE_API_URL, points at the real API.
 */
function apiOrigin(): Plugin {
  const FALLBACK = 'http://localhost:4000';

  let origin = FALLBACK;
  let isBuild = false;

  return {
    name: 'family-greenhouse:api-origin',
    configResolved(config) {
      isBuild = config.command === 'build';
      const raw = config.env.VITE_API_URL;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          origin = new URL(raw).origin;
        } catch {
          // A malformed VITE_API_URL is a deploy misconfiguration, not a reason
          // to emit an empty href — keep the dev default and stay loud in logs.
          config.logger.warn(`[api-origin] VITE_API_URL is not a URL: ${raw}`);
        }
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // Strip explanatory comments from production output. index.html is
        // heavily commented for maintainers — including a long note on the
        // per-route canonical strategy — and none of that belongs in bytes
        // served to every visitor and crawler. Comments stay in the dev server
        // so the file reads the same way it does on disk. Strip BEFORE
        // substituting, so a comment that names the placeholder doesn't get
        // rewritten into nonsense on its way out.
        const stripped = isBuild ? stripHtmlComments(html) : html;
        return stripped.replaceAll('__API_ORIGIN__', origin);
      },
    },
  };
}

// `revision` for the app-shell precache entry. scripts/prerender.mjs writes
// dist/app-shell.html AFTER this build, so workbox can't hash it off disk; give
// it the commit under CI (the deploy workflows set VITE_GIT_SHA) and a
// timestamp locally, so a rebuild always invalidates the cached copy.
const SHELL_REVISION = process.env.VITE_GIT_SHA || String(Date.now());

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    react(),
    apiOrigin(),
    // The SSR pass (`vite build --ssr src/entry-server.tsx`) exists only to
    // produce a Node bundle for the prerender to import. Running the PWA plugin
    // over it would regenerate a service worker from the server bundle and
    // clobber the real one the client build just emitted.
    ...(isSsrBuild
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            // Registration is imported from services/pwaRegistration so rejected
            // browser registrations are handled instead of becoming page errors.
            injectRegister: null,
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
              description:
                'Collaborative household plant care with free accounts for up to 10 plants. Share tasks, reminders, and care history.',
              // Forest browser chrome + the cooler daylight surface match the
              // native icon and launch artwork generated by render-brand-assets.sh.
              theme_color: '#173404',
              background_color: '#F7F8F2',
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
              // Workbox owns the generated app-shell worker; keep push behavior in
              // a small, independently testable classic worker that it imports.
              importScripts: ['push-handler.js'],
              // Take over as soon as the new SW installs instead of waiting for
              // every tab to close. Without this, a deploy can leave users on a
              // stale bundle indefinitely — and a mismatched bundle vs persisted
              // store can break the login flow entirely.
              skipWaiting: true,
              clientsClaim: true,
              cleanupOutdatedCaches: true,
              // Offline navigation fallback. This MUST be the empty SPA shell,
              // not index.html: since the marketing routes are prerendered,
              // index.html is now the rendered HOMEPAGE. Falling back to it
              // would flash the landing page at anyone loading /dashboard with
              // the worker installed. app-shell.html is the pristine shell
              // scripts/prerender.mjs writes for exactly this purpose (and for
              // CloudFront's error response).
              navigateFallback: 'app-shell.html',
              additionalManifestEntries: [{ url: 'app-shell.html', revision: SHELL_REVISION }],
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
        ]),
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
    proxy: {
      '/mock-images': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Keep maps for web/Sentry diagnostics, but never package source into a
    // public native binary. The release wrapper sets this process-only flag.
    sourcemap: process.env.MOBILE_STORE_BUILD !== 'true',
    // CQ-19: explicit chunk-size warning (500 KB) as a build-time signal
    // separate from the hard size-limit CI gate (`npm run size`), and pin the
    // build target to Baseline "Widely available" (evergreen browsers with
    // broad real-world support) instead of trusting Vite's implicit default —
    // an explicit, reviewable choice rather than an unstated one.
    chunkSizeWarningLimit: 500,
    target: 'baseline-widely-available',
    rollupOptions: {
      output: {
        // Vendor/feature splitting is a browser-payload concern. The SSR bundle
        // is loaded once by a Node build script, and chunking it only makes the
        // prerender's dynamic import harder to reason about.
        //
        // The rules themselves live in ./vite.manualChunks.ts so that the test
        // suite can import and run the exact function rollup is handed here,
        // instead of re-deriving it from this file's source text.
        manualChunks: isSsrBuild ? undefined : manualChunks,
      },
    },
  },
}));
