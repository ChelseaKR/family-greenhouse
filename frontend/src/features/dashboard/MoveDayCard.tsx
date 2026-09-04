import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ArrowsRightLeftIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Card } from '@/components/Card';
import { climateService } from '@/services/climateService';
import { moveDayService } from '@/services/moveDayService';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';

/**
 * Seasonal Move Day (ideation brief §4.9): "First frost is tonight. These 9
 * plants need to come inside — here's the list, split between you two."
 *
 * Renders ONLY when the backend says a list exists. Every other state is
 * silence by design — no card and no empty-state nag for a household with no
 * outdoor space or no seasonal homes, a plan without the feature, a night
 * with nothing out of place, or no live climate snapshot. The backend never
 * infers a frost date, and this card never shows a number the snapshot did
 * not measure.
 *
 * Ordering: the evaluation is issued only after the shared climate read has
 * produced a snapshot. The backend then reads the cache row that request
 * just warmed and never calls the weather provider itself, so this card adds
 * zero weather spend.
 *
 * A failed evaluation is silent too, deliberately. ADR 0010 asks a settled
 * failure not to masquerade as calm; the safety signal here — the frost
 * warning itself — lives on ClimateCard, which does render its failure. This
 * card only carries the who-moves-what split, whose absence claims nothing.
 */
export function MoveDayCard() {
  const { t, i18n } = useTranslation();
  const { householdId, householdQuery } = useActiveHousehold();

  // Same key + staleTime as ClimateCard → one fetch, shared.
  const climate = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'climate'],
      (hh) => climateService.getClimate(hh),
      { staleTime: 30 * 60 * 1000 }
    )
  );
  const snapshotReady = Boolean(climate.data?.weather);

  const { data, isError } = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'move-day'],
      (hh) => moveDayService.evaluate(hh),
      { enabled: snapshotReady, staleTime: 30 * 60 * 1000 }
    )
  );

  if (!householdId || isError || !data || data.status !== 'ready') return null;
  const { list } = data;
  if (list.items.length === 0) return null;

  const isWinter = list.season === 'winter';
  const seasonLabel = t(isWinter ? 'moveDay.season.winter' : 'moveDay.season.summer');
  const signal = isWinter
    ? t('moveDay.signalWinter', {
        low: Math.round(list.signal.lowC),
        line: list.signal.frostLineC,
      })
    : t('moveDay.signalSummer', {
        temp: Math.round(list.signal.tempC),
        line: list.signal.heatLineC,
      });
  const firedDate = new Date(list.firedAt).toLocaleDateString(i18n.language, {
    month: 'short',
    day: 'numeric',
  });
  const tender = isWinter ? list.tenderWithoutWinterHome : [];

  return (
    <Card>
      <div className="flex items-start gap-3">
        <ArrowsRightLeftIcon
          className="mt-0.5 h-5 w-5 flex-none text-primary-700"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900">
            {t(isWinter ? 'moveDay.titleWinter' : 'moveDay.titleSummer')}
          </h3>
          <p className="mt-1 text-sm text-gray-700">{signal}</p>
          <p className="mt-1 text-sm text-gray-600">
            {t('moveDay.count', { count: list.items.length, season: seasonLabel })}
          </p>
        </div>
      </div>

      <ul className="mt-4 divide-y divide-primary-100/70" aria-label={t('moveDay.listAria')}>
        {list.items.map((item) => (
          <li key={item.plantId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <Link
                to={`/plants/${item.plantId}`}
                className="font-medium text-gray-900 hover:underline"
              >
                {item.plantName}
              </Link>
              <p className="truncate text-xs text-gray-600">
                {item.fromSpaceName ?? t('moveDay.noCurrentSpace')} → {item.toSpaceName}
              </p>
            </div>
            <span
              className={
                item.assigneeName
                  ? 'shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800'
                  : 'shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700'
              }
            >
              {item.assigneeName ?? t('tasks.upForGrabs')}
            </span>
          </li>
        ))}
      </ul>

      {tender.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          <p className="flex items-start gap-2">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{t('moveDay.tender', { count: tender.length })}</span>
          </p>
          <ul className="ml-8 mt-1 list-disc">
            {tender.map((p) => (
              <li key={p.plantId}>
                <Link to={`/plants/${p.plantId}`} className="font-medium hover:underline">
                  {p.plantName}
                </Link>{' '}
                <span className="text-xs">
                  ({t('moveDay.tenderZone', { zone: p.hardinessZone })})
                </span>
              </li>
            ))}
          </ul>
          <p className="ml-6 mt-1 text-xs">{t('moveDay.tenderHint')}</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-gray-500">
        <span>{t('moveDay.listedOn', { date: firedDate })}</span>
        <Link to="/tasks" className="font-medium text-primary-700 hover:underline">
          {t('moveDay.openTasks')}
        </Link>
      </div>
    </Card>
  );
}
