import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n, { SUPPORTED_LANGS } from '@/i18n';

/**
 * UI preferences. Persisted to localStorage so a refresh doesn't reset the
 * user's density/language. Backend doesn't need to know about these
 * (they're per-device anyway), so we keep them client-side.
 *
 * Theme: dark mode was removed (frontend-audit 2026-06-12, item 6) until
 * components grow real dark variants — the old toggle only inverted the body
 * surface, leaving every card/input unreadable. The persist `migrate` below
 * strips any stale `theme` value ('dark'/'system'/'light') from existing
 * users' localStorage so nothing downstream ever sees it.
 *
 * Density: drives a CSS custom property the cards/lists use to tighten
 * vertical spacing. The default ("cozy") matches the original design;
 * "compact" trims about 25% of vertical padding.
 */
export type Density = 'cozy' | 'compact';
export type LangCode = 'en' | 'es';

interface PrefsState {
  density: Density;
  language: LangCode;
  /** Has the user seen the post-onboarding welcome tour? Once true, the
   *  WelcomeFlow short-circuits to /dashboard so we never re-show it. */
  welcomeSeen: boolean;
  /** Optional do-not-disturb window. "HH:MM" 24h pairs in the user's local
   *  timezone. Empty strings mean "no quiet hours." */
  dndStart: string;
  dndEnd: string;
  /** Per-household snooze for the dashboard shared-care setup prompt. The
   *  prompt is intentionally gentle for people who care for plants solo; a
   *  dismissal hides it on this device for 30 days without changing any
   *  household data or another member's experience. */
  sharedCarePulseDismissedUntil: Record<string, string>;
  setDensity: (d: Density) => void;
  setLanguage: (l: LangCode) => void;
  setWelcomeSeen: (v: boolean) => void;
  setDnd: (start: string, end: string) => void;
  dismissSharedCarePulse: (householdId: string, until: string) => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      density: 'cozy',
      language: SUPPORTED_LANGS.includes(i18n.language as LangCode)
        ? (i18n.language as LangCode)
        : 'en',
      welcomeSeen: false,
      dndStart: '',
      dndEnd: '',
      sharedCarePulseDismissedUntil: {},
      setDensity: (density) => set({ density }),
      setLanguage: (language) => {
        i18n.changeLanguage(language);
        set({ language });
      },
      setWelcomeSeen: (welcomeSeen) => set({ welcomeSeen }),
      setDnd: (dndStart, dndEnd) => set({ dndStart, dndEnd }),
      dismissSharedCarePulse: (householdId, until) =>
        set((state) => ({
          sharedCarePulseDismissedUntil: {
            ...state.sharedCarePulseDismissedUntil,
            [householdId]: until,
          },
        })),
    }),
    {
      name: 'fg.prefs',
      version: 1,
      // v0 → v1: drop the removed `theme` pref. Existing users may have
      // 'dark' persisted; coercing by deletion means everyone gets light.
      migrate: (persisted) => {
        if (persisted && typeof persisted === 'object' && 'theme' in persisted) {
          const rest = { ...(persisted as Record<string, unknown>) };
          delete rest.theme;
          return rest as Partial<PrefsState>;
        }
        return persisted as Partial<PrefsState>;
      },
    }
  )
);

/**
 * Apply density to the DOM. Call on app boot and again when prefs change.
 * We attach an attribute to <html> so CSS can react via attribute selectors
 * without React re-rendering anything.
 */
export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', density);
}
