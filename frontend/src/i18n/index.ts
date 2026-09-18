import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
// Per-locale JSON catalogs (i18next standard `<lng>/<namespace>.json` layout)
// are the single source of truth for UI strings — see docs/i18n.md and
// docs/adr/0007-i18n-json-catalogs-native-format.md. Key/placeholder/plural parity
// across locales is enforced by `npm run i18n:check`
// (frontend/scripts/check-i18n-catalogs.mjs), which CI runs on every PR.
//
// `locales/<lng>/legal.json` is deliberately NOT imported here. It holds the
// privacy/terms/support/account-deletion prose — 116 keys per locale that only
// four rarely-visited routes read — and ./legalCatalog.ts merges it into this
// same `translation` namespace on demand, from those routes. Importing it here
// would put ~37 kB of page copy back on the startup path for every visit.
//
// `locales/<lng>/translation.json` for every NON-English locale is deliberately
// not imported here either. English is the fallback catalog every visitor needs
// on first paint; importing Spanish put 104,586 bytes of JSON into the
// modulepreloaded `i18n` chunk for every visitor, including the English-first
// majority who never read a word of it (#467). ./nonEnglishCatalog.ts fetches
// it as a separate chunk, on demand, only for a visitor whose language is
// Spanish — detected, stored, or picked in Settings.
import en from './locales/en/translation.json';

/**
 * i18n bootstrap. We don't ship a 50-language matrix — start with English
 * (canonical) and Spanish (the next-largest market for a household app), and
 * fall back to English for any missing key so the UI never shows a raw key.
 *
 * Detection order: explicit user choice (localStorage `i18nextLng`) → browser
 * `navigator.language` → fallback. Switching language at runtime calls
 * `i18n.changeLanguage(code)` from the preferences UI.
 *
 * RTL: when the active language is RTL (none in our seed set), `useDirection`
 * applies `dir="rtl"` on the root and Tailwind's logical-property classes
 * already mirror correctly. Adding Arabic later is a translation file and a
 * RTL_LANGS entry below.
 */
/** All locales the codebase has translation files for. */
export const ALL_LANGS = ['en', 'es'] as const;
export type LangCode = (typeof ALL_LANGS)[number];

/**
 * The locales users can reach.
 *
 * Spanish is on (#467). It used to sit behind an opt-in that was set in no
 * deployed environment, so a fully written catalog — every key defined, the
 * identical-to-English values enumerated in locales/es/translation.todo.json,
 * the 95% bar enforced by tests/unit/i18n/localeCoverage.test.ts on every run —
 * was unreachable by any visitor. Two existing paths now reach it, and nothing
 * new was built for either:
 *
 *   - the language detector below: a visitor whose browser asks for Spanish
 *     (`navigator.languages`) boots into Spanish on their first visit;
 *   - the language picker in Settings → Preferences, which renders whenever
 *     more than one locale is supported.
 *
 * A returning visitor keeps whatever `i18nextLng` the detector cached on an
 * earlier visit, and while Spanish was off that was always 'en'. So nobody who
 * has already been using the app in English is switched to Spanish by this
 * change; they can pick it in Settings.
 *
 * WHAT IS STILL ENGLISH on a Spanish screen is listed in docs/i18n.md §
 * Shipping status: JSX text the hardcoded-string ratchet still has baselined,
 * the prerendered marketing HTML (and so every crawler's view), and copy the
 * backend writes.
 *
 * `VITE_ENABLE_NON_ENGLISH_LOCALES=false` at build time is the kill switch: it
 * collapses this to English only, and the pull-back below returns anyone with
 * a stored Spanish preference to English on their next load. Unset means on.
 */
const nonEnglishEnabled = import.meta.env.VITE_ENABLE_NON_ENGLISH_LOCALES !== 'false';

export const SUPPORTED_LANGS = nonEnglishEnabled
  ? ALL_LANGS
  : (['en'] as const as readonly LangCode[]);

export const RTL_LANGS = new Set<string>([]); // ['ar', 'he', 'fa'] when added

export function isRTL(lang: string): boolean {
  return RTL_LANGS.has(lang.split('-')[0]);
}

// The browser language detector reads localStorage and `navigator`, neither of
// which exists in the Node process that runs the build-time prerender
// (scripts/prerender.mjs). Skip it there and pin the render to English — the
// prerendered pages are the canonical English marketing routes, and the client
// re-detects normally on boot. A Spanish-speaking visitor hydrates that English
// markup and re-renders in Spanish when the catalog lands (`bindI18nStore`
// below, and the `changeLanguage` re-run in ensureLanguageCatalog).
const IS_BROWSER = typeof window !== 'undefined';

if (IS_BROWSER) i18n.use(LanguageDetector);

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  ...(IS_BROWSER ? {} : { lng: 'en' }),
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGS as unknown as string[],
  interpolation: {
    escapeValue: false, // React already escapes
  },
  returnNull: false,
  detection: {
    order: ['localStorage', 'navigator'],
    lookupLocalStorage: 'i18nextLng',
    caches: ['localStorage'],
    // Compare base languages, so the visitor's FIRST choice wins. i18next
    // prefers an exact supported code anywhere in the list over a
    // language-only match earlier in it, so without this a browser sending
    // ['en-US', 'es'] boots into Spanish: 'en-US' is not in `supportedLngs`
    // verbatim and 'es' is. Stripping the region makes that ['en', 'es'], and
    // 'es-MX' still resolves to the one Spanish catalog.
    convertDetectedLanguage: (lng: string) => lng.split('-')[0].toLowerCase(),
  },
  react: {
    // Non-English catalogs arrive after init via `addResourceBundle` (see
    // ./nonEnglishCatalog.ts and ./legalCatalog.ts). react-i18next's default
    // `bindI18nStore: ''` ignores store events, so a catalog that lands after
    // the first render leaves the UI showing the English fallback until some
    // unrelated state change happens to re-render it. Binding to `added` makes
    // the arrival itself the trigger.
    bindI18nStore: 'added',
  },
});

/**
 * Register the catalog for `lng` if it is a non-English locale this build lets
 * users reach. Resolves immediately for English and for a build where the
 * kill switch is on, so callers never need to know which is which.
 *
 * The `import()` is what keeps ./nonEnglishCatalog.ts (and the `?url` asset
 * reference it holds) off this module's startup chunk, and it is also why
 * that module does not import this one — the cycle would be pointless.
 */
export function ensureLanguageCatalog(lng: string): Promise<void> {
  if (!nonEnglishEnabled) return Promise.resolve();
  if (lng.split('-')[0].toLowerCase() === 'en') return Promise.resolve();
  return import('./nonEnglishCatalog').then(async ({ baseLanguage, ensureLocaleCatalog }) => {
    await ensureLocaleCatalog(i18n, lng);
    // i18next fixes `resolvedLanguage` from whichever languages had resources
    // when the language was last set (i18next.js `setResolvedLanguage`), and a
    // catalog that arrives afterwards does not re-settle it — so it would keep
    // reporting 'en' while `t()` returned Spanish, which is precisely the kind
    // of "the code says one thing, the screen says another" split this repo
    // gates against. Re-running changeLanguage settles it, and emits
    // `languageChanged` so the re-render does not rest on `bindI18nStore`
    // alone. Only for the language actually on screen: a prefetch must not
    // switch anyone's UI.
    if (i18n.language && baseLanguage(i18n.language) === baseLanguage(lng)) {
      await i18n.changeLanguage(i18n.language);
    }
  });
}

function settleBootLanguage(): Promise<void> {
  // If a stored preference pins the user to a locale this build does not
  // offer (a build with the kill switch on), pull them back to en.
  if (!SUPPORTED_LANGS.includes(i18n.language as LangCode)) {
    void i18n.changeLanguage('en');
    return Promise.resolve();
  }
  if (!IS_BROWSER) return Promise.resolve();
  // The detector may have landed on a non-English locale from localStorage or
  // `navigator.languages`. Its catalog is not bundled, so fetch it now rather
  // than at first interaction. A failure is not fatal — i18next stays on
  // `fallbackLng: 'en'`, which renders English copy, not raw key paths — but
  // it must be visible rather than swallowed.
  return ensureLanguageCatalog(i18n.language).catch((error: unknown) => {
    console.warn(`i18n: could not load the ${i18n.language} catalog`, error);
  });
}

/**
 * Settles once the catalog for the language this page booted in is registered
 * — at once for English. Never rejects: a failed load is logged above and the
 * page renders the English fallback. Nothing has to wait on it (the UI
 * re-renders when the catalog lands); it exists so a caller that needs the
 * boot language settled, such as tests/unit/i18n/localeReachable.test.ts, can
 * wait on the real load instead of polling for it.
 */
export const bootCatalogReady: Promise<void> = settleBootLanguage();

export default i18n;
