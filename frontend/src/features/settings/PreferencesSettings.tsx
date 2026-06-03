import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader } from '@/components/Card';
import {
  applyDensity,
  applyTheme,
  Density,
  LangCode,
  Theme,
  usePrefsStore,
} from '@/store/prefsStore';
import { isRTL, SUPPORTED_LANGS } from '@/i18n';
import clsx from 'clsx';

const THEME_OPTIONS: Theme[] = ['light', 'dark', 'system'];
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
  const theme = usePrefsStore((s) => s.theme);
  const density = usePrefsStore((s) => s.density);
  const language = usePrefsStore((s) => s.language);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const setDensity = usePrefsStore((s) => s.setDensity);
  const setLanguage = usePrefsStore((s) => s.setLanguage);

  // Mirror prefs to the DOM whenever they change in this tab.
  useEffect(() => applyTheme(theme), [theme]);
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
        {/* Theme */}
        <fieldset>
          <legend className="label">{t('settings.preferences.theme')}</legend>
          <div className="flex gap-2" role="radiogroup">
            {THEME_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={clsx(
                  'rounded-md border px-4 py-2 text-sm font-medium min-h-touch',
                  theme === value
                    ? 'border-primary-700 bg-primary-50 text-primary-800'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                )}
              >
                {t(`settings.preferences.theme${value[0].toUpperCase() + value.slice(1)}`)}
              </button>
            ))}
          </div>
        </fieldset>

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
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
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
