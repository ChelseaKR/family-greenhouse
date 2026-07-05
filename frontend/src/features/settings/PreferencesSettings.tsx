import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader } from '@/components/Card';
import { applyDensity, Density, LangCode, usePrefsStore } from '@/store/prefsStore';
import { isRTL, SUPPORTED_LANGS } from '@/i18n';
import clsx from 'clsx';

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

  // Mirror prefs to the DOM whenever they change in this tab.
  useEffect(() => applyDensity(density), [density]);
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

        {/* Density */}
        <fieldset>
          <legend className="label">{t('settings.preferences.density')}</legend>
          <div className="flex gap-2" role="radiogroup">
            {DENSITY_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={density === value}
                onClick={() => setDensity(value)}
                className={clsx(
                  'rounded-md border px-4 py-2 text-sm font-medium min-h-touch',
                  density === value
                    ? 'border-primary-700 bg-primary-50 text-primary-800'
                    : 'border-primary-200/70 bg-paper text-gray-700 hover:bg-primary-50'
                )}
              >
                {t(`settings.preferences.density${value[0].toUpperCase() + value.slice(1)}`)}
              </button>
            ))}
          </div>
        </fieldset>

        {/* Language — hidden when only English ships. The picker reappears
            automatically when VITE_ENABLE_NON_ENGLISH_LOCALES turns on at
            build time, so there's no separate UI gating to remember. */}
        {LANGUAGES.length > 1 && (
          <div>
            <label htmlFor="lang-select" className="label">
              {t('settings.preferences.language')}
            </label>
            <select
              id="lang-select"
              value={language}
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
      </div>
    </Card>
  );
}
