import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';
import type { HouseholdMember } from '@/services/householdService';
import type { Plant, PlantSpace } from '@/services/plantService';
import type { TaskWithCoverage } from '@/services/taskService';
import { Card } from '@/components/Card';
import { PlantImage } from '@/components/PlantImage';
import { formatRelativeDay } from '@/i18n/format';
import { buildSpaceOverviewGroups, type SpaceOverviewGroup } from './spaceOverview';

interface SpaceBrowseViewProps {
  plants: Plant[];
  spaces: PlantSpace[];
  tasks?: TaskWithCoverage[];
  members?: HouseholdMember[];
  latitude?: number | null;
  tasksLoading?: boolean;
  tasksError?: boolean;
  showCareOverview?: boolean;
}

const ROUTE_STRIPE: Record<SpaceOverviewGroup['environment'], string> = {
  inside: 'bg-primary-500',
  outside: 'bg-accent-500',
  unplaced: 'bg-gray-400',
};

export function SpaceBrowseView({
  plants,
  spaces,
  tasks = [],
  members = [],
  latitude,
  tasksLoading = false,
  tasksError = false,
  showCareOverview = true,
}: SpaceBrowseViewProps) {
  const { t } = useTranslation();
  const groups = useMemo(
    () => buildSpaceOverviewGroups(plants, spaces, tasks, members, latitude),
    [latitude, members, plants, spaces, tasks]
  );

  return (
    <div className="space-y-8">
      {showCareOverview && (
        <Card
          variant="paper"
          padding="sm"
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-700">
              {t('spaces.careRoute')}
            </p>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              {t('spaces.overviewDescription')}
            </p>
          </div>
          <ol
            className="flex shrink-0 items-center gap-2 text-xs font-semibold text-gray-600"
            aria-label={t('spaces.routeOrderAria')}
          >
            {(['inside', 'outside', 'unplaced'] as const).map((environment, index) => (
              <li key={environment} className="flex items-center gap-2">
                {index > 0 && <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                <span className="rounded-full bg-parchment px-2.5 py-1">
                  {t(`spaces.${environment}`)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {(['inside', 'outside', 'unplaced'] as const).map((environment) => {
        const environmentGroups = groups.filter((group) => group.environment === environment);
        if (environmentGroups.length === 0) return null;
        return (
          <section key={environment} aria-labelledby={`space-environment-${environment}`}>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 id={`space-environment-${environment}`} className="font-serif text-2xl text-ink">
                {t(`spaces.${environment}`)}
              </h2>
              <span className="text-xs text-gray-500">
                {t('spaces.spaceCount', { count: environmentGroups.length })}
              </span>
            </div>
            <div className="grid gap-5 xl:grid-cols-2">
              {environmentGroups.map((group) => {
                const routeIndex = groups.findIndex((item) => item.id === group.id) + 1;
                const displayName = group.id === 'unplaced' ? t('spaces.unplaced') : group.name;
                const hasSpaceNotes = Boolean(
                  group.space &&
                  (group.space.lightLevel ||
                    group.space.environment === 'outside' ||
                    group.space.petAccess != null ||
                    group.caregiverName)
                );
                return (
                  <Card
                    key={group.id}
                    variant="paper"
                    padding="none"
                    className="relative overflow-hidden"
                  >
                    <div
                      className={clsx('absolute inset-y-0 left-0 w-1.5', ROUTE_STRIPE[environment])}
                      aria-hidden="true"
                    />
                    <article className="p-5 pl-7">
                      <header className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          {showCareOverview && (
                            <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-primary-700">
                              {t('spaces.routeStop', { count: routeIndex })}
                            </p>
                          )}
                          <h3
                            className={clsx(
                              'truncate font-serif text-xl text-ink',
                              showCareOverview && 'mt-1'
                            )}
                          >
                            {displayName}
                          </h3>
                        </div>
                        <span className="shrink-0 rounded-full bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-800">
                          {t('spaces.plantCount', { count: group.plants.length })}
                        </span>
                      </header>

                      {showCareOverview && (
                        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                          <div
                            className={clsx(
                              'flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 text-sm',
                              group.overdueCount > 0
                                ? 'border-red-200 bg-red-50 text-red-800'
                                : group.todayCount > 0
                                  ? 'border-accent-200 bg-accent-50 text-accent-900'
                                  : 'border-primary-100 bg-primary-50/70 text-primary-900'
                            )}
                          >
                            {tasksLoading ? (
                              <>
                                <ClockIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                <span>{t('spaces.tasksLoading')}</span>
                              </>
                            ) : tasksError ? (
                              <>
                                <ExclamationCircleIcon
                                  className="h-5 w-5 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>{t('spaces.tasksUnavailable')}</span>
                              </>
                            ) : group.overdueCount > 0 ? (
                              <>
                                <ExclamationCircleIcon
                                  className="h-5 w-5 shrink-0"
                                  aria-hidden="true"
                                />
                                <span className="font-semibold">
                                  {t('spaces.overdueCount', { count: group.overdueCount })}
                                  {group.todayCount > 0 &&
                                    ` · ${t('spaces.todayCount', { count: group.todayCount })}`}
                                </span>
                              </>
                            ) : group.todayCount > 0 ? (
                              <>
                                <ClockIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                <span className="font-semibold">
                                  {t('spaces.todayCount', { count: group.todayCount })}
                                </span>
                              </>
                            ) : group.nextDue ? (
                              <>
                                <CheckCircleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                <span>
                                  {t('spaces.nextCare', {
                                    date: formatRelativeDay(group.nextDue),
                                  })}
                                </span>
                              </>
                            ) : (
                              <>
                                <CheckCircleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                <span>{t('spaces.noCareTasks')}</span>
                              </>
                            )}
                          </div>
                          {!tasksError && (
                            <Link
                              to={`/tasks?space=${encodeURIComponent(group.id)}`}
                              className="inline-flex min-h-touch items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-primary-800 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                            >
                              {t('spaces.viewCareTasks')}
                              <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
                            </Link>
                          )}
                        </div>
                      )}

                      {group.space && hasSpaceNotes && (
                        <div
                          className="mt-4 flex flex-wrap gap-2"
                          aria-label={t('spaces.spaceNotes')}
                        >
                          {group.space.lightLevel && (
                            <span className="rounded-full border border-primary-100 bg-paper px-2.5 py-1 text-xs text-gray-700">
                              {t(`spaces.light${capitalize(group.space.lightLevel)}`)}
                            </span>
                          )}
                          {group.space.environment === 'outside' && (
                            <span className="rounded-full border border-primary-100 bg-paper px-2.5 py-1 text-xs text-gray-700">
                              {t(`spaces.${group.space.rainExposure ?? 'exposed'}`)}
                            </span>
                          )}
                          {group.space.petAccess != null && (
                            <span className="rounded-full border border-primary-100 bg-paper px-2.5 py-1 text-xs text-gray-700">
                              {t(
                                group.space.petAccess ? 'spaces.petAccessYes' : 'spaces.petAccessNo'
                              )}
                            </span>
                          )}
                          {group.caregiverName && (
                            <span className="rounded-full border border-primary-100 bg-paper px-2.5 py-1 text-xs text-gray-700">
                              {t('spaces.usualCaregiver', { name: group.caregiverName })}
                            </span>
                          )}
                        </div>
                      )}

                      {showCareOverview && group.seasonalMoves.length > 0 && (
                        <div className="mt-4 flex items-start gap-2 rounded-xl bg-accent-50/70 px-3 py-2.5 text-sm text-accent-900">
                          <SparklesIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {t('spaces.seasonalMoveCount', {
                                count: group.seasonalMoves.length,
                              })}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-accent-800">
                              {t('spaces.seasonalMoveSummary', {
                                plants: group.seasonalMoves
                                  .map((move) => move.plantName)
                                  .join(', '),
                                spaces: [
                                  ...new Set(
                                    group.seasonalMoves.map((move) => move.targetSpaceName)
                                  ),
                                ].join(', '),
                              })}
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {group.plants.map((plant) => (
                          <Link
                            key={plant.id}
                            to={`/plants/${plant.id}`}
                            className="group rounded-lg border border-primary-100/70 bg-paper p-2 hover:border-primary-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                          >
                            <div className="aspect-square overflow-hidden rounded-md bg-parchment">
                              <PlantImage plant={plant} width={160} height={160} />
                            </div>
                            <p className="mt-2 truncate text-sm font-medium text-ink">
                              {plant.name}
                            </p>
                            {plant.placementNote && (
                              <p className="truncate text-xs text-gray-600">
                                {plant.placementNote}
                              </p>
                            )}
                          </Link>
                        ))}
                      </div>
                    </article>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
