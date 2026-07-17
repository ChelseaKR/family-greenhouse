import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { Card } from '@/components/Card';
import { SprigDivider } from '@/components/brand/SprigDivider';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';
import { householdService } from '@/services/householdService';
import { plantService } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import { track } from '@/services/analytics';
import { deriveSharedCareMilestones, type SharedCareMilestoneKey } from './sharedCarePulseModel';

const DISMISSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const milestoneRoutes: Record<SharedCareMilestoneKey, string> = {
  plant: '/plants/new',
  task: '/plants',
  teammate: '/household',
  sharedCare: '/tasks',
};

/**
 * A quiet dashboard setup prompt that proves the collaboration loop with real
 * data. React Query reuses the dashboard's plant/activity cache entries, so
 * the only additional reads are the household roster and all active tasks.
 */
export function SharedCarePulse() {
  const { t } = useTranslation();
  const { householdId, householdQuery } = useActiveHousehold();
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const dismissedUntil = usePrefsStore((state) =>
    householdId ? state.sharedCarePulseDismissedUntil[householdId] : undefined
  );
  const dismiss = usePrefsStore((state) => state.dismissSharedCarePulse);

  const plantsQuery = useQuery(
    householdQuery(
      (hh) => ['plants', hh],
      () => plantService.getPlants()
    )
  );
  const tasksQuery = useQuery(
    householdQuery(
      (hh) => ['tasks', hh],
      () => taskService.getTasks()
    )
  );
  const householdQueryResult = useQuery(
    householdQuery(
      (hh) => ['household', hh],
      (hh) => householdService.getHousehold(hh)
    )
  );
  const activityQuery = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'activity'],
      (hh) => householdService.getActivity(hh, 50)
    )
  );

  const milestones = useMemo(
    () =>
      deriveSharedCareMilestones({
        plantCount: plantsQuery.data?.length ?? 0,
        taskCount: tasksQuery.data?.length ?? 0,
        memberUserIds: householdQueryResult.data?.members.map((member) => member.userId) ?? [],
        activity: activityQuery.data ?? [],
        currentUserId,
      }),
    [
      activityQuery.data,
      currentUserId,
      householdQueryResult.data?.members,
      plantsQuery.data?.length,
      tasksQuery.data?.length,
    ]
  );

  const isLoading =
    plantsQuery.isLoading ||
    tasksQuery.isLoading ||
    householdQueryResult.isLoading ||
    activityQuery.isLoading;
  const hasError =
    plantsQuery.isError ||
    tasksQuery.isError ||
    householdQueryResult.isError ||
    activityQuery.isError;
  const completedCount = milestones.filter((milestone) => milestone.completed).length;
  const nextMilestone = milestones.find((milestone) => !milestone.completed);
  const isDismissed = dismissedUntil ? Date.parse(dismissedUntil) > Date.now() : false;

  // Never flash an incomplete checklist while its source queries are loading,
  // and never turn a partial network failure into misleading product advice.
  if (!householdId || isLoading || hasError || !nextMilestone || isDismissed) return null;

  const dismissForThirtyDays = () => {
    dismiss(householdId, new Date(Date.now() + DISMISSAL_WINDOW_MS).toISOString());
    track('shared_care_pulse_action', { context: 'dismiss' });
  };

  const nextKey = nextMilestone.key;

  return (
    <Card
      variant="paper"
      className="relative overflow-hidden border-primary-200/70 bg-primary-50/70"
    >
      <SprigDivider className="pointer-events-none absolute -right-10 -top-3 h-28 w-72 text-primary-800/10" />

      <section aria-labelledby="shared-care-pulse-title" className="relative">
        <div className="flex items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
              {t('sharedCarePulse.eyebrow')}
            </p>
            <h2 id="shared-care-pulse-title" className="mt-1 font-serif text-xl text-ink">
              {t('sharedCarePulse.title')}
            </h2>
            <p className="mt-1 text-sm text-gray-700">{t('sharedCarePulse.description')}</p>
          </div>
          <button
            type="button"
            onClick={dismissForThirtyDays}
            className="inline-flex min-h-touch shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-gray-600 transition-colors hover:bg-paper/80 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            aria-label={t('sharedCarePulse.dismissAria')}
          >
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('sharedCarePulse.notNow')}</span>
          </button>
        </div>

        <p className="mt-5 text-xs font-medium text-primary-800" aria-live="polite">
          {t('sharedCarePulse.progress', { completed: completedCount, total: milestones.length })}
        </p>

        <div className="relative mt-3">
          <div
            className="absolute bottom-5 left-5 top-5 w-px bg-primary-200 sm:bottom-auto sm:left-[12.5%] sm:right-[12.5%] sm:top-5 sm:h-px sm:w-auto"
            aria-hidden="true"
          />
          <ol className="relative grid gap-3 sm:grid-cols-4 sm:gap-2">
            {milestones.map((milestone, index) => {
              const isCurrent = milestone.key === nextKey;
              return (
                <li
                  key={milestone.key}
                  className="relative z-10 flex items-center gap-3 sm:flex-col sm:text-center"
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span
                    className={clsx(
                      'relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold shadow-sm transition-colors',
                      milestone.completed
                        ? 'border-primary-700 bg-primary-700 text-white'
                        : isCurrent
                          ? 'border-primary-600 bg-paper text-primary-800'
                          : 'border-primary-200 bg-paper text-gray-500'
                    )}
                    aria-hidden="true"
                  >
                    {milestone.completed ? <CheckIcon className="h-5 w-5" /> : index + 1}
                    {milestone.completed && (
                      <span className="absolute -right-1 -top-1 h-3 w-2 rotate-45 rounded-br-full rounded-tl-full bg-primary-400" />
                    )}
                  </span>
                  <span
                    className={clsx(
                      'text-sm font-medium',
                      milestone.completed || isCurrent ? 'text-ink' : 'text-gray-500'
                    )}
                  >
                    {t(`sharedCarePulse.milestones.${milestone.key}.title`)}
                    <span className="sr-only">
                      {' — '}
                      {milestone.completed
                        ? t('sharedCarePulse.completeStatus')
                        : isCurrent
                          ? t('sharedCarePulse.currentStatus')
                          : t('sharedCarePulse.upcomingStatus')}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="mt-6 flex flex-col gap-3 border-l-2 border-primary-500 pl-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-ink">
              {t(`sharedCarePulse.milestones.${nextKey}.nextTitle`)}
            </p>
            <p className="mt-0.5 text-sm text-gray-700">
              {t(`sharedCarePulse.milestones.${nextKey}.description`)}
            </p>
          </div>
          <Link
            to={milestoneRoutes[nextKey]}
            onClick={() =>
              track('shared_care_pulse_action', {
                context: nextKey === 'sharedCare' ? 'shared_care' : nextKey,
              })
            }
            className="inline-flex min-h-touch shrink-0 items-center justify-center rounded-lg bg-primary-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            {t(`sharedCarePulse.milestones.${nextKey}.action`)}
          </Link>
        </div>
      </section>
    </Card>
  );
}
