import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n, { SUPPORTED_LANGS } from '@/i18n';

/**
 * UI preferences. Persisted to localStorage so a refresh doesn't reset the
 * user's theme/density/language. Backend doesn't need to know about these
 * (they're per-device anyway), so we keep them client-side.
 *
 * Theme application: `theme` is the user's stated intent; the *applied* theme
 * (light vs dark) is computed via `applyTheme()` because "system" needs to
 * read `prefers-color-scheme`. The HTML root gets `data-theme="dark"` for
 * dark, no attribute for light.
 *
 * Density: drives a CSS custom property the cards/lists use to tighten
 * vertical spacing. The default ("cozy") matches the original design;
 * "compact" trims about 25% of vertical padding.
 */
export type Theme = 'light' | 'dark' | 'system';
export type Density = 'cozy' | 'compact';
export type LangCode = 'en' | 'es';

interface PrefsState {
  theme: Theme;
  density: Density;
  language: LangCode;
  /** Has the user seen the post-onboarding welcome tour? Once true, the
   *  WelcomeFlow short-circuits to /dashboard so we never re-show it. */
  welcomeSeen: boolean;
  /** Optional do-not-disturb window. "HH:MM" 24h pairs in the user's local
   *  timezone. Empty strings mean "no quiet hours." */
  dndStart: string;
  dndEnd: string;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  setLanguage: (l: LangCode) => void;
  setWelcomeSeen: (v: boolean) => void;
  setDnd: (start: string, end: string) => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      theme: 'system',
      density: 'cozy',
      language: SUPPORTED_LANGS.includes(i18n.language as LangCode)
        ? (i18n.language as LangCode)
        : 'en',
      welcomeSeen: false,
      dndStart: '',
      dndEnd: '',
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setLanguage: (language) => {
        i18n.changeLanguage(language);
        set({ language });
      },
      setWelcomeSeen: (welcomeSeen) => set({ welcomeSeen }),
      setDnd: (dndStart, dndEnd) => set({ dndStart, dndEnd }),
    }),
    { name: 'fg.prefs' }
  )
);

/**
 * Apply theme + density to the DOM. Call on app boot and again when prefs
 * change. We attach attributes to <html> so CSS can react via attribute
 * selectors without React re-rendering anything.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  let resolved: 'light' | 'dark';
  if (theme === 'system') {
    resolved =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  } else {
    resolved = theme;
  }
  if (resolved === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', density);
}
