import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { en } from './locales/en';
import { es } from './locales/es';

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
 * Flip `VITE_ENABLE_NON_ENGLISH_LOCALES=true` at build time once translator
 * output lands and there's a strings-coverage check we trust. Until then,
 * the picker hides itself and the runtime forces `en` even if a stale
 * localStorage entry says otherwise.
 */
const nonEnglishEnabled = import.meta.env.VITE_ENABLE_NON_ENGLISH_LOCALES === 'true';

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
