import { resolve } from 'path';
import { loadEnv, type Plugin } from 'vite';

/** Same test as `gaMeasurementId` in src/services/googleAnalytics.ts. */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

/** The rollup input name, and so the stem of the emitted chunk's file name. */
export const GA_BOOT_ENTRY_NAME = 'ga-boot';
/** The module built as that entry. See its header for what it does. */
export const GA_BOOT_SOURCE = resolve(__dirname, 'src/googleAnalyticsBoot.ts');

/** The built-in measurement ID, or null when unset or not a GA4 `G-…` ID. */
export function gaMeasurementIdFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.VITE_GA_MEASUREMENT_ID;
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return MEASUREMENT_ID_PATTERN.test(id) ? id : null;
}

/**
 * Start Google Analytics from the document, ahead of the app bundle.
 *
 * Measured on the throttled mobile profile (2026-11-07), a care page's GA4
 * `page_view` left at about 4.0 s, after the app bundle had downloaded, run
 * and mounted — gtag.js was requested from main.tsx, so nothing about the
 * visit was counted before then. The HTML itself was on screen at 1.6 s.
 *
 * In the production web build (and only there: the plugin is inert without a
 * valid `VITE_GA_MEASUREMENT_ID`, exactly as the loader is), this adds
 * src/googleAnalyticsBoot.ts as a second rollup entry and places its chunk in
 * the <head> of index.html, which scripts/prerender.mjs then carries into
 * every page. Vite still minifies it, hashes it and substitutes the ID.
 *
 * Where in <head> is load-bearing. Module scripts run in document order, each
 * only after every module before it has arrived, so the tag goes BEFORE the
 * app's entry script: placed after it, the first local build ran the boot only
 * once the whole app graph had downloaded — no earlier than main.tsx, and
 * after the loader had already started GA, so both sides sent a page view.
 * `fetchpriority="high"` because Chrome otherwise queues a module script
 * behind the stylesheet, the fonts and the app's chunks; this one is ~1.3 kB
 * and is the reason the page is being counted at all.
 *
 * `order: 'post'` for the same reason as fontPreload: the bundle is only
 * populated by then. A build that asked for the entry and cannot find its
 * chunk fails rather than shipping pages that quietly count late again.
 */
export function googleAnalyticsBoot(): Plugin {
  let enabled = false;
  let base = '/';
  const ENTRY_SCRIPT = '<script type="module"';

  return {
    name: 'family-greenhouse:google-analytics-boot',
    apply: 'build',
    config(userConfig, { mode, isSsrBuild }) {
      // The SSR pass builds the prerender's Node bundle; the boot is browser-only.
      if (isSsrBuild) return null;
      const root = userConfig.root ? resolve(userConfig.root) : process.cwd();
      const envDir = userConfig.envDir === false ? false : resolve(root, userConfig.envDir ?? '.');
      if (!gaMeasurementIdFromEnv(loadEnv(mode, envDir, 'VITE_'))) return null;
      enabled = true;
      return {
        build: {
          rollupOptions: {
            input: {
              index: resolve(root, 'index.html'),
              [GA_BOOT_ENTRY_NAME]: GA_BOOT_SOURCE,
            },
          },
        },
      };
    },
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!enabled) return html;
        const chunk = Object.values(ctx.bundle ?? {}).find(
          (output) =>
            output.type === 'chunk' && output.isEntry && output.name === GA_BOOT_ENTRY_NAME
        );
        if (!chunk) {
          throw new Error(
            `[google-analytics-boot] the "${GA_BOOT_ENTRY_NAME}" entry is not in the bundle — ` +
              'refusing to emit pages that would count page views late again.'
          );
        }
        const tag = `<script type="module" crossorigin fetchpriority="high" src="${base}${chunk.fileName}"></script>`;
        const head = html.indexOf('</head>');
        if (head === -1) {
          throw new Error(
            '[google-analytics-boot] index.html has no </head> to place the boot in.'
          );
        }
        // Before the app's entry when Vite has already placed it in <head>;
        // otherwise at the end of <head>, where that entry would go.
        const entry = html.indexOf(ENTRY_SCRIPT);
        const at = entry !== -1 && entry < head ? entry : head;
        return `${html.slice(0, at)}${tag}\n    ${html.slice(at)}`;
      },
    },
  };
}
