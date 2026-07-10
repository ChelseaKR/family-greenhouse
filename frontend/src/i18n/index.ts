import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
// Per-locale JSON catalogs (i18next standard `<lng>/<namespace>.json` layout)
// are the single source of truth for UI strings — see docs/i18n.md and
// docs/adr/0007-i18n-json-catalogs-and-gates.md. Key/placeholder/plural parity
// across locales is enforced by `npm run i18n:check`
// (frontend/scripts/check-i18n-catalogs.mjs), which CI runs on every PR.
import en from './locales/en/translation.json';
import es from './locales/es/translation.json';

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
 * The locales that are *actually shippable to users*. Translation files for
 * non-English locales today are partial scaffolds, not real translations —
 * exposing them would mislead users into thinking the app speaks Spanish
 * when half the strings still fall through to English.
 *
 * Three layered opt-ins, evaluated in order:
 *   1. URL query param `?locales=on` — flips the flag for this tab and
 *      persists into localStorage. Lets internal/QA testers exercise the
 *      Spanish path without a rebuild.
 *   2. localStorage key `feature:non_english_locales` (set by #1, or
 *      pushed via the browser console).
 *   3. Build-time `VITE_ENABLE_NON_ENGLISH_LOCALES=true` — the global
 *      switch for "ship Spanish to everyone." Stays off by default.
 *
 * Order matters: the build-time flag is the broadest signal, so any of the
 * narrower opt-ins also enables. Disabling is just "remove the localStorage
 * key + leave the env var unset" — the safe default wins on a cold reload.
 */
const LS_KEY_NON_ENGLISH = 'feature:non_english_locales';

function readNonEnglishOptIn(): boolean {
  if (import.meta.env.VITE_ENABLE_NON_ENGLISH_LOCALES === 'true') return true;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('locales') === 'on') {
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

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
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
  });

// If a stale localStorage entry pinned the user to a non-shippable locale
// (e.g. they tested Spanish before the gate landed), pull them back to en.
if (!SUPPORTED_LANGS.includes(i18n.language as LangCode)) {
  i18n.changeLanguage('en');
}

export default i18n;
