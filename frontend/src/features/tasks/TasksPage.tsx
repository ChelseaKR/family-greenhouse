import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckIcon } from '@heroicons/react/24/outline';
import { taskService, SnoozeReason, TaskWithCoverage } from '@/services/taskService';
import { plantService } from '@/services/plantService';
import { climateService } from '@/services/climateService';
import { deriveClimateSignals, climateSkipSuggestion } from './climateSignals';
import { ClaimControls, ClimateSkipChip, CoveringBadge, UpForGrabsBadge } from './taskRowExtras';
import {
  useClaimTaskMutation,
  useSkipCycleMutation,
  useUnclaimTaskMutation,
} from './taskMutations';
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
import { toast } from '@/store/toastStore';

type FilterType = 'all' | 'mine' | 'overdue' | 'today' | 'week';

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
  const user = useAuthStore((state) => state.user);
  const { householdId, householdQuery } = useActiveHousehold();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterType>('all');

  const {
    data: tasks,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['tasks', householdId],
    queryFn: () => taskService.getTasks(),
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

  // Plant tags (for the outdoor-only frost variant) — standard plants query,
  // also typically already cached.
  const { data: plants } = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
  });
  const tagsByPlantId = useMemo(
    () => new Map((plants ?? []).map((p) => [p.id, p.tags ?? []])),
    [plants]
  );

  const completeTaskMutation = useMutation({
    mutationFn: (taskId: string) => taskService.completeTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      toast.success('Task completed');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const claimMutation = useClaimTaskMutation(householdId);
  const unclaimMutation = useUnclaimTaskMutation(householdId);
  const skipMutation = useSkipCycleMutation(householdId);

  const skipReasonFor = (task: TaskWithCoverage) =>
    climateSkipSuggestion(task, tagsByPlantId.get(task.plantId), signals);

  const rowExtras: TaskRowExtras = {
    skipReasonFor,
    onClaim: (id) => claimMutation.mutate(id),
    onUnclaim: (id) => unclaimMutation.mutate(id),
    onSkip: (task, reason) => skipMutation.mutate({ task, reason }),
    claimPending: claimMutation.isPending || unclaimMutation.isPending,
    skipPending: skipMutation.isPending,
  };

  const filteredTasks = tasks?.filter((task) => {
    switch (filter) {
      case 'mine':
        return task.assignedTo === user?.id;
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

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Today's work"
        title="Tasks"
        description="Manage your plant care tasks."
      />

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
            onClick={() => setFilter(f.id as FilterType)}
            className={clsx(
              'inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium border transition-colors',
              filter === f.id
                ? 'bg-primary-100 text-primary-800 border-primary-400'
                : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
            )}
            aria-pressed={filter === f.id}
          >
            {f.label}
            {f.id === 'overdue' && tasks && (
              <span className="ml-1.5 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold rounded-full bg-accent-100 text-accent-800">
                {tasks.filter((t) => isOverdue(t.nextDue)).length}
              </span>
            )}
          </button>
        ))}
      </div>

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
      ) : (
        <div className="space-y-6">
          {overdueTasks.length > 0 && (
            <TaskSection
              title="Overdue"
              tasks={overdueTasks}
              onComplete={(id) => completeTaskMutation.mutate(id)}
              isCompleting={completeTaskMutation.isPending}
              variant="danger"
              extras={rowExtras}
            />
          )}

          {todayTasks.length > 0 && (
            <TaskSection
              title="Today"
              tasks={todayTasks}
              onComplete={(id) => completeTaskMutation.mutate(id)}
              isCompleting={completeTaskMutation.isPending}
              extras={rowExtras}
            />
          )}

          {upcomingTasks.length > 0 && (
            <TaskSection
              title="Upcoming"
              tasks={upcomingTasks}
              onComplete={(id) => completeTaskMutation.mutate(id)}
              isCompleting={completeTaskMutation.isPending}
              extras={rowExtras}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Claim / vacation / climate-skip plumbing shared by every section row. */
interface TaskRowExtras {
  skipReasonFor: (task: TaskWithCoverage) => Extract<SnoozeReason, 'rain' | 'frost'> | null;
  onClaim: (taskId: string) => void;
  onUnclaim: (taskId: string) => void;
  onSkip: (task: TaskWithCoverage, reason: SnoozeReason) => void;
  claimPending: boolean;
  skipPending: boolean;
}

interface TaskSectionProps {
  title: string;
  tasks: TaskWithCoverage[];
  onComplete: (taskId: string) => void;
  isCompleting: boolean;
  variant?: 'default' | 'danger';
  extras: TaskRowExtras;
}

function TaskSection({
  title,
  tasks,
  onComplete,
  isCompleting,
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
              className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-parchment/60"
            >
              <div className="flex items-center gap-4 min-w-0">
                <span
                  className={clsx(
                    'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ring-1',
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
                  {(!task.assignedTo || task.coveringFor || skipReason) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {!task.assignedTo && <UpForGrabsBadge />}
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
              <div className="flex flex-shrink-0 items-center gap-2">
                <ClaimControls
                  task={task}
                  onClaim={extras.onClaim}
                  onUnclaim={extras.onUnclaim}
                  isPending={extras.claimPending}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onComplete(task.id)}
                  disabled={isCompleting}
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
