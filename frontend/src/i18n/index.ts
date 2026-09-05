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
// privacy/terms/support/account-deletion prose — 101 keys per locale that only
// four rarely-visited routes read — and ./legalCatalog.ts merges it into this
// same `translation` namespace on demand, from those routes. Importing it here
// would put ~37 kB of page copy back on the startup path for every visit.
//
// `locales/<lng>/translation.json` for every NON-English locale is deliberately
// not imported here either. English is the fallback catalog every visitor needs
// on first paint; Spanish is not selectable at all unless the opt-in below is
// active, so importing it put 104,586 bytes of JSON into the modulepreloaded
// `i18n` chunk for a language nobody could choose (#467). ./nonEnglishCatalog.ts
// fetches it as a static asset, on demand, for the visitors who opted in.
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
 * The locales that are *actually shippable to users*.
 *
 * WHAT THE GATE IS AND IS NOT. This comment used to say the non-English
 * catalogs were "partial scaffolds, not real translations", with "half the
 * strings still falling through to English". That is not what the catalogs
 * measure: `tests/unit/i18n/localeCoverage.test.ts` reports es at 99.3%
 * (1344/1354 keys), zero missing keys, and the ten values that equal English
 * are enumerated as `intentionallyEqual` in locales/es/translation.todo.json.
 * The remaining blocker is a native-speaker review of the Spanish and the
 * product surface that would come with it (a discoverable switcher or locale
 * detection, `/es` routes, `hreflang`, and the backend copy — household emails
 * and chat safety messages are English regardless of this flag). It is a
 * shipping decision, not a coverage problem. See docs/i18n.md § Shipping
 * status and #467.
 *
 * Until that decision is made, Spanish is a STAGED ASSET rather than a shipped
 * feature that happens to be switched off: ./nonEnglishCatalog.ts keeps its
 * bytes out of the JS every visitor downloads, and the coverage bar keeps it
 * from rotting while it waits.
 *
 * Three layered opt-ins, evaluated in order:
 *   1. URL query param `?locales=on` — flips the flag for this tab and
 *      persists into localStorage. Lets internal/QA testers exercise the
 *      Spanish path without a rebuild. `?locales=off` clears it again.
 *   2. localStorage key `feature:non_english_locales` (set by #1, or
 *      pushed via the browser console).
 *   3. Build-time `VITE_ENABLE_NON_ENGLISH_LOCALES=true` — the global
 *      switch for "ship Spanish to everyone." Stays off by default, and is
 *      set in no deployed environment today.
 *
 * Order matters: the build-time flag is the broadest signal, so any of the
 * narrower opt-ins also enables. Disabling is `?locales=off` (or clearing the
 * localStorage key) plus leaving the env var unset — the safe default wins on
 * a cold reload.
 */
const LS_KEY_NON_ENGLISH = 'feature:non_english_locales';

function readNonEnglishOptIn(): boolean {
  if (import.meta.env.VITE_ENABLE_NON_ENGLISH_LOCALES === 'true') return true;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('locales');
    if (requested === 'off') {
      // The mirror of `?locales=on`. Without it the only way back out of the
      // opt-in was editing localStorage by hand in devtools, so a tester who
      // turned Spanish on stayed on a Spanish-capable build on that device
      // forever. Cannot override the build-time flag, by design: that one is
      // "ship Spanish to everyone" and is not a per-device choice.
      window.localStorage.removeItem(LS_KEY_NON_ENGLISH);
      return false;
    }
    if (requested === 'on') {
      window.localStorage.setItem(LS_KEY_NON_ENGLISH, 'true');
      return true;
    }
    return window.localStorage.getItem(LS_KEY_NON_ENGLISH) === 'true';
  } catch {
    // Private mode etc.; fall through to the safe default.
    return false;
  }
}

const nonEnglishEnabled = readNonEnglishOptIn();

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
// re-detects normally on boot, before hydration.
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
 * non-English opt-in is off, so callers never need to know which is which.
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

// If a stale localStorage entry pinned the user to a non-shippable locale
// (e.g. they tested Spanish before the gate landed), pull them back to en.
if (!SUPPORTED_LANGS.includes(i18n.language as LangCode)) {
  i18n.changeLanguage('en');
} else if (IS_BROWSER) {
  // The detector may have landed on a non-English locale from localStorage or
  // `navigator.language`. Its catalog is no longer bundled, so fetch it now
  // rather than at first interaction. A failure is not fatal — i18next stays
  // on `fallbackLng: 'en'`, which renders English copy, not raw key paths —
  // but it must be visible rather than swallowed.
  void ensureLanguageCatalog(i18n.language).catch((error: unknown) => {
    console.warn(`i18n: could not load the ${i18n.language} catalog`, error);
  });
}

export default i18n;
