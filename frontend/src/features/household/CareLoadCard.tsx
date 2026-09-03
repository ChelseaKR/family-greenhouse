import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { householdService, type HouseholdMember } from '@/services/householdService';
import { taskService } from '@/services/taskService';
import { formatDate } from '@/i18n/format';
import { getErrorMessage } from '@/services/api';
import {
  buildCareLoad,
  CARE_LOAD_WINDOW_DAYS,
  SITTER_ENTRY_KEY,
  type CareLoadEntry,
} from './careLoad';

/**
 * The household's own answer to "who is doing all this?".
 *
 * The product's promise is sharing plant care *without becoming the nag*, and
 * the nagging starts when the split is invisible: the person doing most of it
 * has to raise it themselves, and everyone else has no way to notice. This
 * card puts the same picture in front of every member — care done recently,
 * tasks each person is holding, and the pool nobody has claimed — and then
 * points at the pool rather than at a person.
 *
 * It reads nothing new. The activity feed and the task list are both already
 * visible to every member of the household (GET /households/:id/activity and
 * GET /tasks are member-scoped, not admin-scoped), so this changes no
 * permission boundary — it only saves each person keeping a private tally.
 */

/** The API's page maximum. Asking for it makes truncation as rare as possible. */
const ACTIVITY_LIMIT = 200;

interface CareLoadCardProps {
  householdId: string;
  members: HouseholdMember[];
  currentUserId: string | null;
}

export function CareLoadCard({ householdId, members, currentUserId }: CareLoadCardProps) {
  const { t, i18n } = useTranslation();

  const {
    data: activity,
    isLoading: activityLoading,
    isError: activityFailed,
    error: activityError,
  } = useQuery({
    // A prefix of the dashboard's ['household', id, 'activity'] key, so the
    // existing task-completion invalidation refreshes this card too.
    queryKey: ['household', householdId, 'activity', ACTIVITY_LIMIT],
    queryFn: () => householdService.getActivity(householdId, ACTIVITY_LIMIT),
  });

  const {
    data: tasks,
    isLoading: tasksLoading,
    isError: tasksFailed,
    error: tasksError,
  } = useQuery({
    queryKey: ['tasks', householdId],
    queryFn: () => taskService.getTasks(),
  });

  const summary = useMemo(
    () =>
      activity && tasks
        ? buildCareLoad({ members, activity, activityLimit: ACTIVITY_LIMIT, tasks })
        : null,
    [activity, members, tasks]
  );

  const percent = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language || 'en', {
        style: 'percent',
        maximumFractionDigits: 0,
      }),
    [i18n.language]
  );

  const readError = activityError ?? tasksError ?? null;

  const nameFor = (entry: CareLoadEntry): string => {
    if (entry.key === SITTER_ENTRY_KEY) return t('household.careLoad.sitterLabel');
    return entry.name || t('household.careLoad.unnamedMember');
  };

  const suffixFor = (entry: CareLoadEntry): string | null => {
    if (entry.key === currentUserId) return t('household.careLoad.you');
    if (entry.kind === 'past') return t('household.careLoad.formerMember');
    return null;
  };

  return (
    <Card padding="none">
      <div className="border-b border-primary-100/70 px-6 py-4">
        <CardHeader
          title={t('household.careLoad.title')}
          description={t('household.careLoad.description')}
        />
      </div>

      <div className="px-6 py-5">
        {activityLoading || tasksLoading ? (
          <div className="flex items-center gap-3 text-sm text-gray-600" role="status">
            <LoadingSpinner size="sm" />
            {t('household.careLoad.loading')}
          </div>
        ) : activityFailed || tasksFailed || !summary ? (
          // A failed read is not "nobody has done anything". Saying so plainly
          // matters more here than anywhere else on this page: an empty split
          // is the exact misreading that starts an argument.
          <Alert variant="warning">
            {t('household.careLoad.loadFailed')}
            {readError ? ` ${getErrorMessage(readError)}` : ''}
          </Alert>
        ) : (
          <>
            <p className="text-xs text-gray-600">
              {summary.capped
                ? t('household.careLoad.periodSince', { date: formatDate(summary.periodStart) })
                : t('household.careLoad.periodDays', { days: CARE_LOAD_WINDOW_DAYS })}
            </p>

            <table className="mt-4 w-full text-sm">
              <caption className="sr-only">{t('household.careLoad.tableCaption')}</caption>
              <thead>
                <tr className="border-b border-primary-100/70 text-xs uppercase tracking-wide text-gray-500">
                  <th scope="col" className="py-2 pr-3 text-left font-medium">
                    {t('household.careLoad.personColumn')}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-left font-medium">
                    {t('household.careLoad.doneColumn')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('household.careLoad.assignedColumn')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary-100/60">
                {summary.entries.map((entry) => {
                  const suffix = suffixFor(entry);
                  return (
                    <tr key={entry.key}>
                      <th
                        scope="row"
                        className="py-3 pr-3 text-left font-medium text-gray-900 align-top"
                      >
                        {nameFor(entry)}
                        {suffix && (
                          // The space is load-bearing: without it a screen
                          // reader runs the name and the note together.
                          <>
                            {' '}
                            <span className="text-xs font-normal text-gray-500">({suffix})</span>
                          </>
                        )}
                      </th>
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="hidden h-2 w-20 shrink-0 overflow-hidden rounded-full bg-primary-100 sm:block"
                            aria-hidden="true"
                          >
                            <span
                              className="block h-full rounded-full bg-primary-600"
                              style={{
                                width: `${entry.share * 100}%`,
                                minWidth: entry.completed > 0 ? '4px' : 0,
                              }}
                            />
                          </span>
                          <span className="tabular-nums text-gray-900">{entry.completed}</span>
                          <span aria-hidden="true" className="text-gray-300">
                            ·
                          </span>
                          <span className="tabular-nums text-gray-600">
                            {percent.format(entry.share)}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 text-right tabular-nums text-gray-900">
                        {entry.holding}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {summary.totalCompleted === 0 && (
              <p className="mt-4 text-sm text-gray-600">{t('household.careLoad.nothingLogged')}</p>
            )}

            {summary.leadCarrier && (
              // Pointed at the person carrying the load, not the ones who
              // aren't — and the suggested move is the shared pool, so nobody
              // has to be asked by name.
              <div className="mt-5 border-l-2 border-primary-500 pl-4">
                <p className="text-sm font-semibold text-ink">
                  {t('household.careLoad.lopsided', { name: nameFor(summary.leadCarrier) })}
                </p>
                <p className="mt-0.5 text-sm text-gray-700">
                  {t('household.careLoad.lopsidedBody')}
                </p>
              </div>
            )}

            <div className="mt-5 rounded-lg border border-primary-100 bg-primary-50/60 p-4">
              {summary.upForGrabs > 0 ? (
                <>
                  <p className="text-sm font-medium text-primary-900">
                    {t('household.careLoad.upForGrabs', { total: summary.upForGrabs })}
                  </p>
                  <p className="mt-0.5 text-sm text-primary-900/80">
                    {t('household.careLoad.upForGrabsBody')}
                  </p>
                  <Link
                    to="/tasks"
                    className="mt-2 inline-flex min-h-touch items-center text-sm font-medium text-primary-700 underline hover:text-primary-800"
                  >
                    {t('household.careLoad.upForGrabsAction')}
                  </Link>
                </>
              ) : (
                <p className="text-sm text-primary-900">{t('household.careLoad.allSpokenFor')}</p>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
