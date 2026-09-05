/**
 * Deferred loader for the `legal.*` catalog.
 *
 * WHY THIS EXISTS
 * The privacy, terms, support and account-deletion prose is 116 keys per
 * locale (101 when it was split out here; the commercial terms added 15) —
 * 36.8 kB raw, ~10.4 kB brotli across en + es as measured at 101. Imported from
 * `src/i18n/index.ts` it rode the startup catalog, so every visitor downloaded
 * and parsed all of it on every visit, in both locales, even though the four
 * routes that read it are lazy, rarely visited, and Spanish is still gated off
 * (see SUPPORTED_LANGS in ./index.ts). `_size-limit-note-0-23-legal-i18n` in
 * frontend/package.json called this out and named this fix.
 *
 * WHAT IT DOES
 * Loads `locales/<lng>/legal.json` on demand and merges each fragment into the
 * `translation` namespace with `addResourceBundle`. The fragments are already
 * rooted at `legal`, so every `t('legal.…')` / `<Trans i18nKey="legal.…">` call
 * site in `src/features/legal/` is unchanged by the move — the keys are
 * byte-identical to the ones that used to live in `translation.json`.
 *
 * WHY IT CANNOT RACE
 * `App.tsx` awaits this promise *inside* the `React.lazy()` factory for each
 * legal route, alongside the page's own chunk. React never mounts a lazy
 * component before its factory settles, so there is no frame in which a legal
 * page can render a raw `legal.foo.bar` key:
 *
 *   - Browser navigation: Suspense holds the fallback until both settle.
 *   - Hydration of a prerendered page: React keeps the server markup on screen
 *     while the boundary is suspended, then hydrates against it.
 *   - Build-time prerender: `react-dom/static`'s `prerender()` waits for the
 *     whole tree to settle (see src/entry-server.tsx), so /legal/privacy and
 *     /legal/terms are emitted with the full prose, not a spinner.
 *
 * It is one plain `import()` in every environment — browser, the Node SSR pass
 * that feeds scripts/prerender.mjs, and vitest — so there is no second code
 * path that could drift, and no network request that could fail on its own.
 */
import i18n from './index';

/** Locales whose legal copy this module registers. Mirrors ALL_LANGS. */
const LEGAL_LOCALES = ['en', 'es'] as const;

/**
 * In-flight/settled load. Memoized so four routes (and repeated navigations)
 * share one chunk fetch; cleared on failure so a retry can actually retry
 * rather than replaying a rejected promise forever.
 */
let pending: Promise<void> | null = null;

async function load(): Promise<void> {
  const { legalCatalogs } = await import('./legalCatalogChunk');
  for (const lng of LEGAL_LOCALES) {
    // deep = true, overwrite = true: merge under the existing `translation`
    // bundle without disturbing the keys already there.
    i18n.addResourceBundle(lng, 'translation', legalCatalogs[lng], true, true);
  }
}

/**
 * Ensure the `legal.*` keys are registered on the shared i18n instance.
 *
 * Rejects if the chunk cannot be loaded. Callers must not swallow that: an
 * unresolved catalog renders raw key strings, which is exactly the
 * "absence rendered as a value" failure this repo gates against. Letting it
 * reject surfaces the route error boundary instead.
 */
export function loadLegalCatalog(): Promise<void> {
  pending ??= load().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** True once the catalog is registered for `lng`. Used by tests and guards. */
export function isLegalCatalogLoaded(lng: string): boolean {
  return i18n.getResource(lng, 'translation', 'legal') !== undefined;
}
