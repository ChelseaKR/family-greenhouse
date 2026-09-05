import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarDaysIcon, CheckIcon, MapPinIcon } from '@heroicons/react/24/outline';
import { taskService, SnoozeReason, TaskWithCoverage } from '@/services/taskService';
import { plantService } from '@/services/plantService';
import { climateService } from '@/services/climateService';
import { deriveClimateSignals, climateSkipSuggestion } from './climateSignals';
import {
  AskedForHelpBadge,
  AskFamilyButton,
  ClaimControls,
  ClimateSkipChip,
  CoveringBadge,
  UpForGrabsBadge,
} from './taskRowExtras';
import { isHelpRequestOpen } from './helpRequest';
import { AskFamilyDialog } from './AskFamilyDialog';
import {
  useAskFamilyMutation,
  useClaimTaskMutation,
  useCompleteTaskMutation,
  useSkipCycleMutation,
  useUnclaimTaskMutation,
} from './taskMutations';
import { careRuleFor, useCareRuleGate } from './useCareRuleGate';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { EmptyTasks } from '@/components/illustrations/EmptyTasks';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { taskTypeLabels, taskTypeStyles } from '@/utils/taskTypeConfig';
import { calendarDaysBetween } from '@/utils/date';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useSpaces } from '@/hooks/useSpaces';
import { buildCareRoundGroups, filterTasksForSpace } from './careRounds';
import { TaskLocation } from '@/components/TaskLocation';
import { plantLocationLabel } from '@/utils/spaces';

type FilterType = 'all' | 'mine' | 'overdue' | 'today' | 'week';

function filterFromSearchParam(value: string | null): FilterType {
  // Notification links historically used `filter=due`; keep those links
  // useful by mapping "due" to the existing today + overdue care queue.
  if (value === 'due') return 'today';
  return value === 'mine' || value === 'overdue' || value === 'today' || value === 'week'
    ? value
    : 'all';
}

function formatDueDate(dateString: string): string {
  const date = new Date(dateString);
  // calendarDaysBetween is DST-safe (UTC-noon anchored) — local-midnight
  // subtraction + Math.ceil reported "2 days overdue" for yesterday across
  // the fall-back transition.
  const diff = calendarDaysBetween(new Date(), date);

  if (diff < 0) {
    const daysOverdue = -diff;
    return `${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue`;
  }
  if (diff === 0) {
    return 'Today';
  }
  if (diff === 1) {
    return 'Tomorrow';
  }
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function isOverdue(dateString: string): boolean {
  const date = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

function isToday(dateString: string): boolean {
  const date = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() === today.getTime();
}

export function TasksPage() {
  useDocumentTitle('Tasks');
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const { householdId, householdQuery } = useActiveHousehold();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSpaceFilter = searchParams.get('space');
  const requestedTaskFilter = filterFromSearchParam(searchParams.get('filter'));
  const [filter, setFilter] = useState<FilterType>(requestedTaskFilter);
  const [displayMode, setDisplayMode] = useState<'schedule' | 'round'>(() =>
    requestedSpaceFilter ? 'round' : 'schedule'
  );

  useEffect(() => {
    setFilter(requestedTaskFilter);
  }, [requestedTaskFilter]);

  function selectFilter(nextFilter: FilterType): void {
    setFilter(nextFilter);
    const nextParams = new URLSearchParams(searchParams);
    if (nextFilter === 'all') {
      nextParams.delete('filter');
    } else {
      nextParams.set('filter', nextFilter);
    }
    setSearchParams(nextParams, { replace: true });
  }

  const {
    data: tasks,
    isLoading: tasksLoading,
    error: tasksError,
  } = useQuery({
    queryKey: ['tasks', householdId],
    queryFn: () => taskService.getTasks(),
    enabled: Boolean(householdId),
  });

  // Existing household climate query (shared key with the dashboard's
  // ClimateCard, so this is usually a cache hit) — drives the one-tap
  // "skip this cycle" suggestions. No new endpoints.
  const { data: climate } = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'climate'],
      (hh) => climateService.getClimate(hh),
      { staleTime: 30 * 60 * 1000 }
    )
  );
  const signals = deriveClimateSignals(climate);

  // Plant placement makes rain/frost suggestions specific to where the plant
  // actually lives, rather than relying on a free-form "outdoor" tag.
  const {
    data: plants,
    isLoading: plantsLoading,
    error: plantsError,
  } = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
    enabled: Boolean(householdId),
  });
  const {
    spaces,
    byId: spacesById,
    status: spacesStatus,
    unavailable: spacesUnavailable,
    error: spacesError,
  } = useSpaces();
  const spacesLoading = spacesStatus === 'loading';
  const plantsById = useMemo(() => new Map((plants ?? []).map((p) => [p.id, p])), [plants]);
  // A failed rooms read only becomes a blocking error when a room FILTER is
  // active (below); the rest of the page still works. What it must not do is
  // let every task quietly read "Unplaced" — the placement is unknown, not
  // absent.
  const unplacedLabel = spacesUnavailable ? t('spaces.locationUnknown') : t('spaces.unplaced');
  const activeSpaceFilter =
    requestedSpaceFilter === 'unplaced' ||
    (requestedSpaceFilter != null && spacesById.has(requestedSpaceFilter))
      ? requestedSpaceFilter
      : null;
  const activeSpaceName =
    activeSpaceFilter === 'unplaced'
      ? t('spaces.unplaced')
      : activeSpaceFilter
        ? (spacesById.get(activeSpaceFilter)?.name ?? null)
        : null;
  const spaceScopedTasks = useMemo(
    () => filterTasksForSpace(tasks ?? [], plants ?? [], spaces, activeSpaceFilter),
    [activeSpaceFilter, plants, spaces, tasks]
  );
  // `tasks` is undefined while loading AND after a failed read. The filter
  // chips render outside the loading/error branch below, so counting
  // `spaceScopedTasks` (coalesced from `?? []`) published "Overdue 0" next to
  // the error alert — a failed schedule read dressed as a calm all-clear.
  // Same three-state rule as the dashboard metrics: no data means no number.
  const overdueCount =
    tasks === undefined ? null : spaceScopedTasks.filter((t) => isOverdue(t.nextDue)).length;
  const isLoading =
    tasksLoading || (Boolean(requestedSpaceFilter) && (plantsLoading || spacesLoading));
  const error = tasksError || (requestedSpaceFilter ? (plantsError ?? spacesError) : null);

  const completeTaskMutation = useCompleteTaskMutation(householdId);
  // House rule gate: a plant with a care rule shows it before the completion
  // goes through; with no rule the click completes exactly as before.
  const careRuleGate = useCareRuleGate<TaskWithCoverage>(
    (task) => careRuleFor(plantsById.get(task.plantId)),
    (task) => completeTaskMutation.mutate({ taskId: task.id, expectedNextDue: task.nextDue })
  );

  const claimMutation = useClaimTaskMutation(householdId);
  const unclaimMutation = useUnclaimTaskMutation(householdId);
  const skipMutation = useSkipCycleMutation(householdId);
  const askMutation = useAskFamilyMutation(householdId);
  // The task an ask is being composed for; null closes the dialog.
  const [askTarget, setAskTarget] = useState<TaskWithCoverage | null>(null);

  const skipReasonFor = (task: TaskWithCoverage) => {
    const spaceId = plantsById.get(task.plantId)?.spaceId;
    return climateSkipSuggestion(task, spaceId ? spacesById.get(spaceId) : undefined, signals);
  };

  const rowExtras: TaskRowExtras = {
    skipReasonFor,
    locationFor: (task) =>
      plantsById.has(task.plantId)
        ? plantLocationLabel(plantsById.get(task.plantId)!, spacesById, unplacedLabel)
        : unplacedLabel,
    onClaim: (id) => claimMutation.mutate(id),
    onUnclaim: (id) => unclaimMutation.mutate(id),
    onAsk: (task) => setAskTarget(task),
    onSkip: (task, reason) => skipMutation.mutate({ task, reason }),
    claimPending: claimMutation.isPending || unclaimMutation.isPending,
    askPending: askMutation.isPending,
    skipPending: skipMutation.isPending,
  };

  const filteredTasks = spaceScopedTasks.filter((task) => {
    switch (filter) {
      case 'mine':
        // Covers vacation hand-off: a task whose assignee is away still
        // belongs to the cover's "My Tasks" (see effectiveAssignee in
        // taskService.annotateTasksWithCoverage).
        return task.assignedTo === user?.id || task.effectiveAssignee === user?.id;
      case 'overdue':
        return isOverdue(task.nextDue);
      case 'today':
        return isToday(task.nextDue) || isOverdue(task.nextDue);
      case 'week': {
        const weekFromNow = new Date();
        weekFromNow.setDate(weekFromNow.getDate() + 7);
        return new Date(task.nextDue) <= weekFromNow;
      }
      default:
        return true;
    }
  });

  // Sort tasks by due date
  const sortedTasks = [...(filteredTasks || [])].sort(
    (a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime()
  );

  // Group tasks by due status
  const overdueTasks = sortedTasks.filter((t) => isOverdue(t.nextDue));
  const todayTasks = sortedTasks.filter((t) => isToday(t.nextDue));
  const upcomingTasks = sortedTasks.filter((t) => !isOverdue(t.nextDue) && !isToday(t.nextDue));
  // Announce the consequence of a filter press, not only the chip's own
  // pressed state: the sections below re-render with a different set and
  // nothing else says so (#447). Empty while the read is unsettled — "0 tasks
  // shown" next to an error alert is the same failed-read-as-all-clear defect
  // the overdue chip above was fixed for.
  const taskCountSummary =
    isLoading || error || tasks === undefined
      ? ''
      : `${sortedTasks.length} ${sortedTasks.length === 1 ? 'task' : 'tasks'} shown.`;

  const careRoundGroups = useMemo(
    () => buildCareRoundGroups(sortedTasks, plants ?? [], spaces, t('spaces.unplaced')),
    [plants, sortedTasks, spaces, t]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Today's work"
        title="Tasks"
        description="Manage your plant care tasks."
      />

      {activeSpaceName && (
        <Card
          variant="paper"
          padding="sm"
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-800">
              <MapPinIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">
                {t('spaces.taskFilterTitle', { space: activeSpaceName })}
              </p>
              <p className="text-xs text-gray-600">{t('spaces.taskFilterDescription')}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              const nextParams = new URLSearchParams(searchParams);
              nextParams.delete('space');
              setSearchParams(nextParams, { replace: true });
            }}
          >
            {t('spaces.showAllTaskSpaces')}
          </Button>
        </Card>
      )}

      <div
        className="inline-flex rounded-lg border border-primary-200/70 bg-paper p-1"
        role="group"
        aria-label={t('careRounds.displayMode')}
      >
        <button
          type="button"
          onClick={() => setDisplayMode('schedule')}
          aria-pressed={displayMode === 'schedule'}
          className={clsx(
            'inline-flex min-h-touch items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
            displayMode === 'schedule'
              ? 'bg-primary-100 text-primary-900'
              : 'text-gray-600 hover:bg-primary-50'
          )}
        >
          <CalendarDaysIcon className="h-5 w-5" aria-hidden="true" />
          {t('careRounds.schedule')}
        </button>
        <button
          type="button"
          onClick={() => setDisplayMode('round')}
          aria-pressed={displayMode === 'round'}
          className={clsx(
            'inline-flex min-h-touch items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
            displayMode === 'round'
              ? 'bg-primary-100 text-primary-900'
              : 'text-gray-600 hover:bg-primary-50'
          )}
        >
          <MapPinIcon className="h-5 w-5" aria-hidden="true" />
          {t('careRounds.round')}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Task filters">
        {[
          { id: 'all', label: 'All' },
          { id: 'mine', label: 'My tasks' },
          { id: 'today', label: 'Today' },
          { id: 'week', label: 'This week' },
          { id: 'overdue', label: 'Overdue' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => selectFilter(f.id as FilterType)}
            className={clsx(
              'inline-flex min-h-touch items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
              filter === f.id
                ? 'bg-primary-100 text-primary-800 border-primary-400'
                : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
            )}
            aria-pressed={filter === f.id}
          >
            {f.label}
            {f.id === 'overdue' && (
              <span
                className="ml-1.5 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold rounded-full bg-accent-100 text-accent-800"
                {...(overdueCount === null ? { 'aria-label': 'Overdue count unknown' } : {})}
              >
                {overdueCount === null ? '—' : overdueCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <p aria-live="polite" className="text-sm text-gray-600">
        {taskCountSummary}
      </p>

      {/* Task list */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <Alert variant="error">{getErrorMessage(error)}</Alert>
      ) : !sortedTasks || sortedTasks.length === 0 ? (
        <EmptyState
          icon={<EmptyTasks className="mx-auto h-40 w-auto" />}
          title="No tasks found"
          description={
            filter === 'all'
              ? 'Add care tasks to your plants to see them here.'
              : 'No tasks match the current filter.'
          }
          action={
            filter !== 'all' ? (
              <Button variant="secondary" onClick={() => setFilter('all')}>
                Clear filter
              </Button>
            ) : (
              <Link to="/plants">
                <Button>View plants</Button>
              </Link>
            )
          }
        />
      ) : displayMode === 'round' ? (
        <div className="space-y-6">
          <Card variant="paper">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full bg-primary-100 text-primary-800">
                <MapPinIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-serif text-xl text-ink">{t('careRounds.title')}</h2>
                <p className="mt-1 text-sm text-gray-600">
                  {t('careRounds.summary', {
                    tasks: sortedTasks.length,
                    spaces: careRoundGroups.length,
                  })}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  {careRoundGroups.map((group) => group.name).join(' → ')}
                </p>
              </div>
            </div>
          </Card>
          {careRoundGroups.map((group) => (
            <TaskSection
              key={group.id}
              title={`${t(`spaces.${group.environment}`)} · ${group.name}`}
              tasks={group.tasks}
              onComplete={careRuleGate.request}
              completingTaskId={
                completeTaskMutation.isPending
                  ? (completeTaskMutation.variables?.taskId ?? null)
                  : null
              }
              extras={rowExtras}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {overdueTasks.length > 0 && (
            <TaskSection
              title="Overdue"
              tasks={overdueTasks}
              onComplete={careRuleGate.request}
              completingTaskId={
                completeTaskMutation.isPending
                  ? (completeTaskMutation.variables?.taskId ?? null)
                  : null
              }
              variant="danger"
              extras={rowExtras}
            />
          )}

          {todayTasks.length > 0 && (
            <TaskSection
              title="Today"
              tasks={todayTasks}
              onComplete={careRuleGate.request}
              completingTaskId={
                completeTaskMutation.isPending
                  ? (completeTaskMutation.variables?.taskId ?? null)
                  : null
              }
              extras={rowExtras}
            />
          )}

          {upcomingTasks.length > 0 && (
            <TaskSection
              title="Upcoming"
              tasks={upcomingTasks}
              onComplete={careRuleGate.request}
              completingTaskId={
                completeTaskMutation.isPending
                  ? (completeTaskMutation.variables?.taskId ?? null)
                  : null
              }
              extras={rowExtras}
            />
          )}
        </div>
      )}
      {careRuleGate.dialog}
      <AskFamilyDialog
        isOpen={askTarget !== null}
        plantName={askTarget?.plantName ?? ''}
        isPending={askMutation.isPending}
        onClose={() => setAskTarget(null)}
        onConfirm={(note) => {
          if (!askTarget) return;
          askMutation.mutate({ task: askTarget, note });
          setAskTarget(null);
        }}
      />
    </div>
  );
}

/** Claim / vacation / climate-skip plumbing shared by every section row. */
interface TaskRowExtras {
  skipReasonFor: (task: TaskWithCoverage) => Extract<SnoozeReason, 'rain' | 'frost'> | null;
  locationFor: (task: TaskWithCoverage) => string;
  onClaim: (taskId: string) => void;
  onUnclaim: (taskId: string) => void;
  onAsk: (task: TaskWithCoverage) => void;
  onSkip: (task: TaskWithCoverage, reason: SnoozeReason) => void;
  claimPending: boolean;
  askPending: boolean;
  skipPending: boolean;
}

interface TaskSectionProps {
  title: string;
  tasks: TaskWithCoverage[];
  onComplete: (task: TaskWithCoverage) => void;
  completingTaskId: string | null;
  variant?: 'default' | 'danger';
  extras: TaskRowExtras;
}

function TaskSection({
  title,
  tasks,
  onComplete,
  completingTaskId,
  variant = 'default',
  extras,
}: TaskSectionProps) {
  return (
    <Card variant="paper" padding="none">
      <div
        className={clsx(
          'px-6 py-3 border-b',
          variant === 'danger'
            ? 'bg-accent-50/60 border-accent-200/70'
            : 'bg-parchment/60 border-primary-100/70'
        )}
      >
        <h2
          className={clsx(
            'text-sm font-semibold',
            variant === 'danger' ? 'text-accent-800' : 'text-ink'
          )}
        >
          {title}
          <span className="ml-2 text-gray-600 font-normal">({tasks.length})</span>
        </h2>
      </div>
      <ul className="divide-y divide-primary-100/60">
        {tasks.map((task) => {
          const style = taskTypeStyles[task.type] ?? taskTypeStyles.custom;
          const { Icon } = style;
          const skipReason = extras.skipReasonFor(task);
          return (
            <li
              key={task.id}
              className="flex flex-col gap-4 px-4 py-4 transition-colors hover:bg-parchment/60 sm:flex-row sm:items-center sm:justify-between sm:px-6"
            >
              <div className="flex items-center gap-4 min-w-0">
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
                  <Link
                    to={`/plants/${task.plantId}`}
                    className="text-sm font-medium text-ink hover:text-primary-700"
                  >
                    {task.plantName}
                  </Link>
                  <p className="text-xs text-gray-600">
                    <span className="font-medium">
                      {task.customType || taskTypeLabels[task.type]}
                    </span>
                    {' • '}
                    <span
                      className={clsx(isOverdue(task.nextDue) && 'text-accent-700 font-medium')}
                    >
                      {formatDueDate(task.nextDue)}
                    </span>
                    {task.assignedToName && ` • Assigned to ${task.assignedToName}`}
                  </p>
                  <TaskLocation label={extras.locationFor(task)} />
                  {(!task.assignedTo || task.coveringFor || skipReason) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {!task.assignedTo &&
                        (isHelpRequestOpen(task) ? (
                          // A housemate asked: say who, not "auto-handoff".
                          <AskedForHelpBadge
                            name={task.helpAskedByName ?? null}
                            note={task.helpAskedNote}
                          />
                        ) : (
                          <UpForGrabsBadge escalated={task.escalatedForDue === task.nextDue} />
                        ))}
                      {task.coveringFor && <CoveringBadge name={task.coveringFor} />}
                      {skipReason && (
                        <ClimateSkipChip
                          reason={skipReason}
                          onSkip={() => extras.onSkip(task, skipReason)}
                          isPending={extras.skipPending}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
                <ClaimControls
                  task={task}
                  onClaim={extras.onClaim}
                  onUnclaim={extras.onUnclaim}
                  isPending={extras.claimPending}
                />
                <AskFamilyButton task={task} onAsk={extras.onAsk} isPending={extras.askPending} />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onComplete(task)}
                  disabled={completingTaskId === task.id}
                  leftIcon={<CheckIcon className="h-4 w-4" aria-hidden="true" />}
                >
                  Done
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
