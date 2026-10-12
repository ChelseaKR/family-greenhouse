import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card, CardHeader } from '@/components/Card';
import { applyDensity, Density, LangCode, usePrefsStore } from '@/store/prefsStore';
import { ensureLanguageCatalog, isRTL, SUPPORTED_LANGS } from '@/i18n';
import { analyticsOptOutStored } from '@/services/analytics';
import { setAnalyticsPreference } from '@/services/googleAnalytics';
import clsx from 'clsx';
import { nativeSwitchRole } from '@/lib/platform';

const DENSITY_OPTIONS: Density[] = ['cozy', 'compact'];
const LANGUAGE_LABELS: Record<LangCode, string> = {
  en: 'English',
  es: 'Español',
};
const LANGUAGES: { code: LangCode; label: string }[] = SUPPORTED_LANGS.map((code) => ({
  code,
  label: LANGUAGE_LABELS[code],
}));

export function PreferencesSettings() {
  const { t } = useTranslation();
  const density = usePrefsStore((s) => s.density);
  const language = usePrefsStore((s) => s.language);
  const setDensity = usePrefsStore((s) => s.setDensity);
  const setLanguage = usePrefsStore((s) => s.setLanguage);
  // The product-analytics opt-out lives with the shim, not in the prefs store:
  // it is a per-device flag the shim reads on every event (docs/analytics.md,
  // "Opt-out signals"), and the ONLY opt-out that works inside the iOS shell,
  // where the browser signals never fire. Read once on mount; the shim is the
  // source of truth and this state just mirrors it for the checkbox.
  const [analyticsShared, setAnalyticsShared] = useState(() => !analyticsOptOutStored());
  const onAnalyticsChange = (shared: boolean) => {
    // The same switch as the public footer's "Opt out of analytics": one flag
    // silences PostHog and Google Analytics alike, and deletes the GA cookies
    // now rather than at expiry (services/googleAnalytics.ts).
    setAnalyticsPreference(!shared);
    setAnalyticsShared(!analyticsOptOutStored());
  };

  // Mirror prefs to the DOM whenever they change in this tab.
  useEffect(() => applyDensity(density), [density]);

  // Warm the catalogs the picker can select, once the user reaches for it.
  // Non-English copy is a separate chunk rather than bundled
  // (src/i18n/nonEnglishCatalog.ts), so without this the first switch would
  // render the English fallback for the length of one request. This used to
  // run on mount, which was harmless while the picker only rendered for
  // opted-in testers; now that it renders for everyone, a mount prefetch would
  // hand every English speaker who opens Settings the Spanish catalog (#467).
  // Pointer-down (mouse, touch) or focus (keyboard) comes before the change
  // event, so the fetch still starts ahead of the switch. Memoized, so
  // repeats are one request; a failure is not actionable here — setLanguage
  // reports it and i18next stays on English — so it is deliberately not
  // surfaced in the UI.
  const warmLanguageCatalogs = () => {
    for (const { code } of LANGUAGES) {
      void ensureLanguageCatalog(code).catch(() => undefined);
    }
  };
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = isRTL(language) ? 'rtl' : 'ltr';
  }, [language]);

  return (
    <Card>
      <CardHeader
        title={t('settings.preferences.title')}
        description={t('settings.preferences.description')}
      />
      <div className="space-y-6">
        {/* Theme toggle removed: dark mode shipped half-baked (only the body
            surface inverted, components stayed light and unreadable). Restore
            it here once components have real dark variants.
            See docs/reviews/frontend-audit-2026-06-12.md, item 6. */}

        {/* Density: a segmented control, as in iOS Settings. Still a radio
            group underneath: the selected segment is the one Tab stops on,
            and the arrow keys move the choice. */}
        <fieldset>
          <legend className="label" id="density-label">
            {t('settings.preferences.density')}
          </legend>
          <div
            className="inline-grid grid-cols-2 gap-0.5 rounded-full bg-gray-500/10 p-0.5 large-text:grid-cols-1 large-text:rounded-3xl"
            role="radiogroup"
            aria-labelledby="density-label"
          >
            {DENSITY_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                data-density={value}
                aria-checked={density === value}
                tabIndex={density === value ? 0 : -1}
                onKeyDown={(event) => {
                  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
                    event.key
                  ];
                  if (!step) return;
                  event.preventDefault();
                  const at = DENSITY_OPTIONS.indexOf(density);
                  const next =
                    DENSITY_OPTIONS[(at + step + DENSITY_OPTIONS.length) % DENSITY_OPTIONS.length];
                  setDensity(next);
                  event.currentTarget
                    .closest('[role="radiogroup"]')
                    ?.querySelector<HTMLButtonElement>(`[data-density="${next}"]`)
                    ?.focus();
                }}
                onClick={() => setDensity(value)}
                className={clsx(
                  'min-h-touch rounded-full px-5 text-sm font-semibold',
                  density === value
                    ? 'bg-paper text-ink shadow-sm ring-1 ring-primary-100'
                    : 'text-gray-700 hover:bg-primary-50'
                )}
              >
                {t(`settings.preferences.density${value[0].toUpperCase() + value.slice(1)}`)}
              </button>
            ))}
          </div>
        </fieldset>

        {/* Language — hidden only in a build with the kill switch on
            (VITE_ENABLE_NON_ENGLISH_LOCALES=false), where English is the only
            locale. There's no separate UI gating to remember. */}
        {LANGUAGES.length > 1 && (
          <div>
            <label htmlFor="lang-select" className="label">
              {t('settings.preferences.language')}
            </label>
            <select
              id="lang-select"
              value={language}
              onPointerDown={warmLanguageCatalogs}
              onFocus={warmLanguageCatalogs}
              onChange={(e) => setLanguage(e.target.value as LangCode)}
              className="input max-w-xs"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Product analytics — the in-app opt-out the privacy page names.
            Sized to a 28px box (not the 20px `h-5 w-5` this file's other
            checkboxes use, which get away with it by living inside a
            wrapping <label>): a bare `<input>` referenced by a separate
            `<label htmlFor>`, as here, isn't exempt from
            responsive-ux.spec.ts's 24px minimum control-target check, and
            wrapping this one would fold the description paragraph and the
            privacy link's own text into the checkbox's accessible name.
            `h-7 w-7` keeps the name exactly "Share usage events" and clears
            the 24px floor without relying on exact-boundary rounding. */}
        <fieldset>
          <legend className="label">{t('settings.preferences.analytics')}</legend>
          <div className="flex items-start justify-between gap-4">
            <div>
              <label htmlFor="analytics-shared" className="text-sm font-medium text-gray-900">
                {t('settings.preferences.analyticsToggle')}
              </label>
              <p className="mt-1 text-sm text-gray-600">
                {t('settings.preferences.analyticsDescription')}{' '}
                <Link to="/privacy" className="underline">
                  {t('settings.preferences.analyticsPrivacyLink')}
                </Link>
              </p>
            </div>
            <input
              {...nativeSwitchRole()}
              id="analytics-shared"
              type="checkbox"
              className="mt-1 h-7 w-7 shrink-0 accent-primary-700"
              checked={analyticsShared}
              onChange={(e) => onAnalyticsChange(e.target.checked)}
            />
          </div>
        </fieldset>
      </div>
    </Card>
  );
}
