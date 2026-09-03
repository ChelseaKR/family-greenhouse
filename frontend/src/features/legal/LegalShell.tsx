import { useTranslation } from 'react-i18next';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { formatDate } from '@/i18n/format';
import { REVIEWED_LEGAL_LOCALES } from './reviewedLocales';

interface LegalShellProps {
  title: string;
  /** ISO calendar date (`YYYY-MM-DD`); rendered as a long date in the active locale. */
  effectiveDate: string;
  children: React.ReactNode;
}

/**
 * `new Date('2026-09-02')` parses as UTC midnight and prints as the 1st
 * anywhere west of Greenwich. Build the date from its parts so the day on
 * the page is the day in the source, in every timezone.
 */
function localCalendarDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Shared chrome for /legal/privacy, /legal/terms, /support and
 * /account-deletion. Rides on PublicShell so the legal pages read as part of
 * the same site as the blog, care guides, and changelog rather than a
 * differently-styled annex.
 */
export function LegalShell({ title, effectiveDate, children }: LegalShellProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const baseLanguage = language.split('-')[0];
  const isTranslation = baseLanguage !== 'en';
  const isReviewed = REVIEWED_LEGAL_LOCALES.has(baseLanguage);
  const date = formatDate(
    localCalendarDate(effectiveDate),
    { month: 'long', day: 'numeric', year: 'numeric' },
    language
  );

  return (
    <PublicShell>
      <PageIntro eyebrow={t('legal.shell.eyebrow')} title={title} />
      <p className="mt-4 text-sm text-gray-600">{t('legal.shell.effective', { date })}</p>

      {isTranslation && (
        <div
          role="note"
          className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"
        >
          {!isReviewed && <p className="font-semibold">{t('legal.shell.translationDraft')}</p>}
          <p className={isReviewed ? undefined : 'mt-1'}>{t('legal.shell.translationGoverning')}</p>
        </div>
      )}

      <div className="prose-fg mt-10">{children}</div>
    </PublicShell>
  );
}
