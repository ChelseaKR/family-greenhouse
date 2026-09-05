/**
 * Deferred loader for the non-English UI catalogs.
 *
 * WHY THIS EXISTS
 * `src/i18n/index.ts` used to `import es from './locales/es/translation.json'`
 * unconditionally and register it in `resources`. Spanish is not selectable in
 * any deployed environment (`SUPPORTED_LANGS` in ./index.ts collapses to
 * `['en']` unless the opt-in is active), so every visitor downloaded and parsed
 * the whole Spanish catalog on the startup path to reach a language they could
 * not choose — 86.6 kB of JSON, pinned by vite.manualChunks.ts into the `i18n`
 * chunk that dist/index.html modulepreloads. #467 measured it; this module and
 * the narrowed chunk rule are the fix.
 *
 * WHY `import()` AND NOT `?url` + fetch
 * Fetching the catalog as an emitted `.json` asset is the standard i18next
 * shape and would also take the bytes out of `dist/assets/*.js`, which is what
 * the `All JS combined` size budget globs — that budget counts bytes EMITTED
 * and is immune to lazy-loading (see the size-limit notes in
 * frontend/package.json). It was built that way first, and measured: aggregate
 * 501.33 -> 481.65 kB brotli.
 *
 * It cannot ship yet. All three deploy paths — .github/workflows/
 * cd-production.yml, cd-staging.yml and scripts/deploy.sh — sync `dist` with
 * `--exclude "*.json"` and no compensating include, so a JSON file under
 * `dist/` is never uploaded at all. The catalog would 404 for every user who
 * opted in, and nothing in CI would notice, because the build and the size
 * gate both pass. Moving the bytes out of the JS output needs that deploy
 * change first; until then a code-split chunk is what actually reaches S3.
 *
 * WHAT IT DOES NOT DO
 * It does not decide *whether* a locale may be selected. That policy lives in
 * ./index.ts (`SUPPORTED_LANGS` / `ensureLanguageCatalog`); this module only
 * knows how to load a catalog and merge it in. It deliberately does not import
 * ./index either, so there is no cycle with the module that lazy-loads it.
 *
 * FAILURE MODE
 * A rejected load leaves i18next on the `fallbackLng: 'en'` catalog, so the UI
 * renders English copy rather than raw `some.key.path` strings. Callers must
 * not treat a rejection as success — ./index.ts logs it and stays on English.
 */
import type { i18n as I18nInstance } from 'i18next';

/**
 * Base language code → a dynamic import of its catalog.
 *
 * `en` is absent on purpose: it is the fallback catalog and is imported
 * statically by ./index.ts, because every visitor needs it on first paint.
 *
 * Each entry MUST be a literal `import()` of a literal path — that is what
 * makes rollup emit a separate chunk. A variable path, or hoisting these to a
 * static import, folds the catalogs back into whatever imports this module.
 */
const CATALOG_LOADERS: Readonly<Record<string, () => Promise<{ default: object }>>> = Object.freeze(
  {
    es: () => import('./locales/es/translation.json'),
  }
);

/** The base language codes this build can load a catalog for. */
export const NON_ENGLISH_CATALOGS: readonly string[] = Object.freeze(Object.keys(CATALOG_LOADERS));

/** 'es-MX' → 'es'. Catalogs are keyed by base language, as i18next resolves. */
export function baseLanguage(lng: string): string {
  return lng.split('-')[0].toLowerCase();
}

/**
 * In-flight/settled loads, one per base language. Memoized so a boot-time load
 * and a preferences-picker load share a single chunk fetch; cleared on failure
 * so a retry can actually retry instead of replaying a rejected promise.
 */
const pending = new Map<string, Promise<void>>();

async function load(
  instance: I18nInstance,
  lng: string,
  loader: () => Promise<{ default: object }>
): Promise<void> {
  const { default: catalog } = await loader();
  // deep = true, overwrite = true: same merge semantics as legalCatalog.ts, so
  // this catalog and a later `legal.*` fragment can land in either order.
  instance.addResourceBundle(lng, 'translation', catalog, true, true);
}

/**
 * Ensure `lng`'s catalog is registered on `instance`.
 *
 * Resolves immediately for English (statically bundled) and for a locale that
 * is already registered. Rejects for a locale with no catalog — that is a
 * programming error, not a runtime condition, and resolving silently would
 * leave the caller believing a language it cannot render is ready.
 */
export function ensureLocaleCatalog(instance: I18nInstance, lng: string): Promise<void> {
  const code = baseLanguage(lng);
  if (code === 'en') return Promise.resolve();

  const loader = CATALOG_LOADERS[code];
  if (!loader) {
    return Promise.reject(new Error(`i18n: no catalog is published for '${code}'`));
  }
  if (instance.hasResourceBundle(code, 'translation')) return Promise.resolve();

  let inFlight = pending.get(code);
  if (!inFlight) {
    inFlight = load(instance, code, loader).catch((error: unknown) => {
      pending.delete(code);
      throw error;
    });
    pending.set(code, inFlight);
  }
  return inFlight;
}
