/**
 * Today, across your homes (ADR 0017).
 *
 * A work queue, not a global view: one section per household the caller
 * belongs to, each labelled with the home's name and the caller's role
 * THERE, and every row repeats its home so nothing is ever read out of
 * context. Nothing is merged across homes.
 *
 * Three states are rendered distinctly and none of them looks like the
 * others (ADR 0010): a home that answered with nothing due says so in its
 * own words; a home we could not reach is an explicit "unavailable" card
 * with a retry; and a tier without the feature gets the homes-and-hands
 * explanation on this URL — never a 404 and never an empty list.
 */
import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowTopRightOnSquareIcon, CheckIcon, HomeModernIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { buttonStyles } from '@/components/buttonStyles';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { EmptyTasks } from '@/components/illustrations/EmptyTasks';
import { ClaimControls, CoveringBadge, UpForGrabsBadge } from '@/features/tasks/taskRowExtras';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/services/api';
import { COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';
import {
  CROSS_HOME_TODAY_QUERY_KEY,
  crossHomeTodayService,
  endOfLocalDay,
  isPlanLocked,
  type CrossHomeTodayHousehold,
  type CrossHomeTodayRow,
} from '@/services/crossHomeTodayService';
import { taskTypeLabel, taskTypeStyle } from '@/utils/taskTypeConfig';
import { isOverdue } from '@/utils/date';
import {
  useCrossHomeClaimMutation,
  useCrossHomeCompleteMutation,
  useCrossHomeUnclaimMutation,
} from './crossHomeMutations';

interface RowActions {
  onComplete: (task: CrossHomeTodayRow) => void;
  onClaim: (task: CrossHomeTodayRow) => void;
  onUnclaim: (task: CrossHomeTodayRow) => void;
  /** The one row with a mutation in flight; its controls are disabled. */
  pendingTaskId: string | null;
}

export function CrossHomeTodayPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('today.title'));

  const { data, status, error, refetch, isFetching } = useQuery({
    queryKey: CROSS_HOME_TODAY_QUERY_KEY,
    queryFn: () => crossHomeTodayService.get(endOfLocalDay()),
    // A 402 is an answer, not a transient failure — don't retry the gate.
    // Anything else gets one automatic retry; the page carries its own
    // "Try again" for the rest.
    retry: (failureCount, err) => !isPlanLocked(err) && failureCount < 1,
    staleTime: 30_000,
  });

  const complete = useCrossHomeCompleteMutation();
  const claim = useCrossHomeClaimMutation();
  const unclaim = useCrossHomeUnclaimMutation();
  const pendingTaskId = complete.isPending
    ? (complete.variables?.task.id ?? null)
    : claim.isPending
      ? (claim.variables?.task.id ?? null)
      : unclaim.isPending
        ? (unclaim.variables?.task.id ?? null)
        : null;
  const actions: RowActions = {
    onComplete: (task) => complete.mutate({ householdId: task.householdId, task }),
    onClaim: (task) => claim.mutate({ householdId: task.householdId, task }),
    onUnclaim: (task) => unclaim.mutate({ householdId: task.householdId, task }),
    pendingTaskId,
  };

  const header = (
    <PageHeader
      eyebrow={t('today.eyebrow')}
      title={t('today.title')}
      description={t('today.description')}
    />
  );

  if (status === 'pending') {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex justify-center py-12" role="status">
          <LoadingSpinner size="lg" />
          <span className="sr-only">{t('today.loading')}</span>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-6">
        {header}
        {isPlanLocked(error) ? (
          <LockedCard />
        ) : (
          <div className="space-y-4">
            <Alert variant="error">{getErrorMessage(error)}</Alert>
            <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
              {t('today.retry')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {data.households.length === 0 ? (
        <EmptyState
          icon={<EmptyTasks className="mx-auto h-40 w-auto" />}
          title={t('today.noHomes')}
          action={
            <Link to="/onboarding?mode=add" className={buttonStyles()}>
              {t('today.addHome')}
            </Link>
          }
        />
      ) : (
        data.households.map((household) => (
          <HouseholdSection
            key={household.householdId}
            household={household}
            actions={actions}
            onRetry={() => refetch()}
            retrying={isFetching}
          />
        ))
      )}
    </div>
  );
}

/** The tier explanation, on this URL, in place of the queue. */
function LockedCard() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader title={t('today.lockedTitle')} description={t('today.lockedDescription')} />
      <Alert variant="info">
        {COMMERCIAL_HOLD_ACTIVE ? t('today.lockedPaused') : t('today.lockedUpgrade')}
      </Alert>
      <Link to="/settings/billing" className={buttonStyles({ className: 'mt-4' })}>
        {t('today.viewPlanStatus')}
      </Link>
    </Card>
  );
}

interface HouseholdSectionProps {
  household: CrossHomeTodayHousehold;
  actions: RowActions;
  onRetry: () => void;
  retrying: boolean;
}

function HouseholdSection({ household, actions, onRetry, retrying }: HouseholdSectionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const headingId = useId();
  const user = useAuthStore((s) => s.user);
  const setActiveHouseholdId = useAuthStore((s) => s.setActiveHouseholdId);

  const displayName = household.name ?? t('today.unavailableUnnamed');
  const roleLabel = household.role === 'admin' ? t('today.roleAdmin') : t('today.roleMember');

  // Convenience, not contract: switch the active household (the same move
  // the sidebar switcher makes) and land on that home's own task queue.
  const openHome = () => {
    setActiveHouseholdId(
      household.householdId === user?.householdId ? null : household.householdId
    );
    navigate('/tasks?filter=today');
  };

  const overdueCount =
    household.status === 'ok' ? household.tasks.filter((x) => isOverdue(x.nextDue)).length : null;
  const dueTodayCount =
    household.status === 'ok' && overdueCount !== null
      ? household.tasks.length - overdueCount
      : null;

  return (
    <Card variant="paper" padding="none">
      <section aria-labelledby={headingId}>
        <div
          className={clsx(
            'flex flex-wrap items-center justify-between gap-2 border-b px-6 py-3',
            household.status === 'unavailable'
              ? 'border-yellow-200/80 bg-yellow-50/60'
              : 'border-primary-100/70 bg-parchment/60'
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <HomeModernIcon className="h-5 w-5 shrink-0 text-primary-700" aria-hidden="true" />
            <h2 id={headingId} className="truncate text-sm font-semibold text-ink">
              {displayName}
            </h2>
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-800 ring-1 ring-primary-200/70">
              {roleLabel}
            </span>
            {overdueCount !== null && dueTodayCount !== null && (
              <p className="text-xs text-gray-600">
                <span className={clsx(overdueCount > 0 && 'font-medium text-accent-700')}>
                  {t('today.overdueCount', { count: overdueCount })}
                </span>
                {' · '}
                <span>{t('today.dueTodayCount', { count: dueTodayCount })}</span>
              </p>
            )}
          </div>
          {household.status === 'ok' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={openHome}
              leftIcon={<ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {t('today.openHome', { name: displayName })}
            </Button>
          )}
        </div>

        {household.status === 'unavailable' ? (
          <div className="space-y-3 p-4">
            <Alert variant="warning" title={t('today.unavailableTitle')}>
              {t('today.unavailableBody', { name: displayName })}
            </Alert>
            <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
              {t('today.retry')}
            </Button>
          </div>
        ) : household.tasks.length === 0 ? (
          <p className="px-6 py-4 text-sm text-gray-600">
            {t('today.nothingDue', { name: displayName })}
          </p>
        ) : (
          <ul className="divide-y divide-primary-100/60">
            {household.tasks.map((task) => (
              <TaskRow key={task.id} task={task} actions={actions} />
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}

function TaskRow({ task, actions }: { task: CrossHomeTodayRow; actions: RowActions }) {
  const { t } = useTranslation();
  const style = taskTypeStyle(task.type);
  const { Icon } = style;
  const overdue = isOverdue(task.nextDue);
  const pending = actions.pendingTaskId === task.id;

  return (
    <li className="flex flex-col gap-4 px-4 py-4 transition-colors hover:bg-parchment/60 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex min-w-0 items-center gap-4">
        <span
          className={clsx(
            'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-1',
            style.chip
          )}
          aria-hidden="true"
        >
          <Icon className={clsx('h-6 w-6', style.iconColor)} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{task.plantName}</p>
          <p className="text-xs text-gray-600">
            <span className="font-medium">{task.customType || taskTypeLabel(task.type)}</span>
            {' • '}
            <span className={clsx(overdue && 'font-medium text-accent-700')}>
              {overdue ? t('tasks.overdue') : t('today.dueToday')}
            </span>
            {task.assignedToName && (
              <>
                {' • '}
                <span>{t('today.assignedTo', { name: task.assignedToName })}</span>
              </>
            )}
          </p>
          {/* The home, on every row — the rule that keeps this a queue and
              not a merged list, even when a row is read on its own. */}
          <p className="mt-1 flex items-center gap-1 text-xs text-primary-800">
            <HomeModernIcon className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span className="truncate">{t('today.inHome', { name: task.householdName })}</span>
          </p>
          {(!task.assignedTo || task.coveringFor) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {!task.assignedTo && <UpForGrabsBadge />}
              {task.coveringFor && <CoveringBadge name={task.coveringFor} />}
            </div>
          )}
        </div>
      </div>
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
        <ClaimControls
          task={task}
          onClaim={() => actions.onClaim(task)}
          onUnclaim={() => actions.onUnclaim(task)}
          isPending={pending}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => actions.onComplete(task)}
          disabled={pending}
          leftIcon={<CheckIcon className="h-4 w-4" aria-hidden="true" />}
          aria-label={t('today.completeAria', { plant: task.plantName, name: task.householdName })}
        >
          {t('tasks.complete')}
        </Button>
      </div>
    </li>
  );
}
