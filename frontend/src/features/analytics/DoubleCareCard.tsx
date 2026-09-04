import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card, CardHeader } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import type { DailyAnalytics } from '@/services/householdService';

interface DoubleCareCardProps {
  loading: boolean;
  /** `undefined` after loading = the analytics read failed. */
  daily: DailyAnalytics | undefined;
}

function monthLabel(month: string, locale: string | undefined): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Confirmed double-care this month. Four explicit states — loading, a real
 * count (0 is a real count only when the server says `ok`), unavailable, and
 * not-in-plan — so a failed read is never rendered as "0 duplicates".
 */
export function DoubleCareCard({ loading, daily }: DoubleCareCardProps) {
  const { t, i18n } = useTranslation();
  // An older backend without the field is the same as a failed count.
  const state = loading ? 'loading' : (daily?.doubleCare?.status ?? 'unavailable');

  return (
    <Card>
      <CardHeader
        title={t('doubleCare.analytics.title')}
        description={t('doubleCare.analytics.description')}
      />
      {state === 'loading' ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner />
        </div>
      ) : state === 'ok' && daily?.doubleCare?.status === 'ok' ? (
        <div>
          <p className="font-serif text-2xl text-ink">
            {daily.doubleCare.confirmedDuplicates === 0
              ? t('doubleCare.analytics.none')
              : t('doubleCare.analytics.count', { count: daily.doubleCare.confirmedDuplicates })}
          </p>
          <p className="mt-1 text-xs text-gray-600">
            {t('doubleCare.analytics.month', {
              month: monthLabel(daily.doubleCare.month, i18n.resolvedLanguage),
            })}
          </p>
        </div>
      ) : state === 'not_in_plan' ? (
        <p className="text-sm text-gray-600">
          {t('doubleCare.analytics.locked')}{' '}
          <Link to="/pricing" className="font-medium text-primary-700 underline">
            {t('doubleCare.analytics.seePlans')}
          </Link>
        </p>
      ) : (
        <p className="text-sm text-gray-600">{t('doubleCare.analytics.unavailable')}</p>
      )}
    </Card>
  );
}
