import { useTranslation } from 'react-i18next';
import { formatDate } from '@/i18n/format';

export interface Incident {
  /** The day it began, as written: `YYYY-MM-DD`, shown without a time-zone shift. */
  date: string;
  resolved: boolean;
  /** Catalog keys, so an entry reads in every language the page is offered in. */
  titleKey: string;
  bodyKey: string;
}

/** The hand-kept log. Takes its entries as a prop so the empty state stays testable. */
export function IncidentLog({
  incidents,
  unreachable,
  serverErrored,
}: {
  incidents: Incident[];
  unreachable: boolean;
  serverErrored: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className="mt-12">
      <h2 className="font-serif text-2xl tracking-tight text-ink">
        {t('statusPage.recentIncidents')}
      </h2>
      {incidents.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600">
          {/* An empty list says nobody has written anything up, not that
                nothing happened, so it never claims "no incidents". */}
          {unreachable
            ? t('statusPage.historyUnavailable')
            : serverErrored
              ? t('statusPage.detailsToFollow')
              : t('statusPage.emptyLog')}
        </p>
      ) : (
        <ul className="mt-4 space-y-6">
          {incidents.map((inc, i) => (
            <li
              key={`${inc.date}-${i}`}
              className="rounded-xl border border-primary-100/80 bg-white p-5 shadow-journal"
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    inc.resolved ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900'
                  }`}
                >
                  {inc.resolved ? t('statusPage.resolved') : t('statusPage.investigating')}
                </span>
                {/* UTC, because a bare date parses as midnight UTC: read in the
                    United States, it would otherwise print the day before. */}
                <span className="text-gray-600">{formatDate(inc.date, { timeZone: 'UTC' })}</span>
              </div>
              <h3 className="mt-2 font-serif text-lg text-ink">{t(inc.titleKey)}</h3>
              <p className="mt-1 text-sm text-gray-700">{t(inc.bodyKey)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
