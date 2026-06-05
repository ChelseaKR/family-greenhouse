import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckIcon } from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { taskService } from '@/services/taskService';
import { plantService, Task } from '@/services/plantService';
import { householdService } from '@/services/householdService';
import { useOverdueAlerts } from '@/hooks/useOverdueAlerts';
import { YearInReviewCard } from './YearInReviewCard';
import { ClimateCard } from './ClimateCard';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { PageHeader } from '@/components/PageHeader';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { EmptyActivity } from '@/components/illustrations/EmptyActivity';
import { Alert } from '@/components/Alert';
import { SprigDivider } from '@/components/brand/SprigDivider';
import { DashboardHeaderArt } from '@/components/headers/DashboardHeaderArt';
import { getErrorMessage } from '@/services/api';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { taskTypeLabels, taskTypeStyles } from '@/utils/taskTypeConfig';
import { toast } from '@/store/toastStore';

function formatDueDate(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  today.setHours(0, 0, 0, 0);
  tomorrow.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);

  if (date.getTime() < today.getTime()) {
    return 'Overdue';
  }
  if (date.getTime() === today.getTime()) {
    return 'Today';
  }
  if (date.getTime() === tomorrow.getTime()) {
    return 'Tomorrow';
  }
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

type ActivityFilter = 'all' | 'tasks' | 'plants' | 'people';

const filterLabels: Record<ActivityFilter, string> = {
  all: 'All',
  tasks: 'Tasks',
  plants: 'Plants',
  people: 'People',
};

function filterActivity(
  events: import('@/services/householdService').ActivityEvent[],
  filter: ActivityFilter
) {
  if (filter === 'all') return events;
  return events.filter((e) => {
    if (filter === 'tasks') return e.type === 'task.completed';
    if (filter === 'plants')
      return (
        e.type === 'plant.created' || e.type === 'plant.deleted' || e.type === 'photo.uploaded'
      );
    if (filter === 'people') return e.type === 'member.joined' || e.type === 'member.left';
    return true;
  });
}

function isOverdue(dateString: string): boolean {
  const date = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();

  const {
    data: upcomingTasks,
    isLoading: tasksLoading,
    error: tasksError,
  } = useQuery({
    queryKey: ['tasks', 'upcoming'],
    queryFn: taskService.getUpcomingTasks,
  });

  const {
    data: plants,
    isLoading: plantsLoading,
    error: plantsError,
  } = useQuery({
    queryKey: ['plants'],
    queryFn: plantService.getPlants,
  });

  useOverdueAlerts(upcomingTasks);

  const { data: activity } = useQuery({
    queryKey: ['household', user?.householdId, 'activity'],
    // Pull a wider window so client-side filters have something to chew on;
    // 50 keeps round-trip light while making the "Plants" or "People" pills
    // feel non-empty even when watering dominates the feed.
    queryFn: () => householdService.getActivity(user!.householdId!, 50),
    enabled: !!user?.householdId,
  });

  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const filteredActivity = useMemo(
    () => filterActivity(activity ?? [], activityFilter).slice(0, 10),
    [activity, activityFilter]
  );

  const completeTaskMutation = useMutation({
    mutationFn: (taskId: string) => taskService.completeTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('Task completed');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const handleCompleteTask = async (taskId: string) => {
    try {
      await completeTaskMutation.mutateAsync(taskId);
    } catch {
      // Error is handled by the mutation
    }
  };

  const overdueTasks = upcomingTasks?.filter((task) => isOverdue(task.nextDue)) || [];
  const todayTasks =
    upcomingTasks?.filter(
      (task) => !isOverdue(task.nextDue) && formatDueDate(task.nextDue) === 'Today'
    ) || [];
  const laterTasks =
    upcomingTasks?.filter(
      (task) => !isOverdue(task.nextDue) && formatDueDate(task.nextDue) !== 'Today'
    ) || [];

  const plantCount = plantsLoading ? null : (plants?.length ?? 0);
  const todayCount = tasksLoading ? null : todayTasks.length;
  const overdueCount = tasksLoading ? null : overdueTasks.length;

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Your household"
        title={`Welcome back, ${user?.name?.split(' ')[0] ?? 'friend'}`}
        description="Here's what's happening with your plants today."
        art={<DashboardHeaderArt className="w-full h-auto" />}
      />

      {/* Inline metadata row — demoted from the old 3-tile hero grid. The
          page no longer shouts numbers at you; the dashboard art is the
          focal element and these read as a quiet status line beneath the
          title. */}
      <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3 -mt-4 text-sm">
        <Metric label="Plants" value={plantCount} />
        <Metric label="Due today" value={todayCount} />
        <Metric
          label="Overdue"
          value={overdueCount}
          emphasis={overdueCount && overdueCount > 0 ? 'alert' : undefined}
        />
      </dl>

      {/* Upcoming Tasks */}
      <Card variant="paper" padding="none">
        <div className="px-6 py-5 border-b border-primary-100/70">
          <CardHeader
            title="Upcoming tasks"
            description="Due in the next 7 days"
            action={
              <Link to="/tasks">
                <Button variant="secondary" size="sm">
                  View all
                </Button>
              </Link>
            }
          />
        </div>

        {tasksLoading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : tasksError ? (
          <div className="p-6">
            <Alert variant="error">{getErrorMessage(tasksError)}</Alert>
          </div>
        ) : !upcomingTasks || upcomingTasks.length === 0 ? (
          <EmptyState
            title="No upcoming tasks"
            description="All caught up! Add tasks to your plants to see them here."
            action={
              <Link to="/plants">
                <Button>View plants</Button>
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-primary-100/60">
            {[...overdueTasks, ...todayTasks, ...laterTasks].slice(0, 10).map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onComplete={handleCompleteTask}
                isCompleting={completeTaskMutation.isPending}
              />
            ))}
          </ul>
        )}
      </Card>

      <SprigDivider className="mx-auto h-6 w-40 text-primary-700/40" aria-hidden="true" />

      {/* Recent Plants */}
      <Card variant="paper">
        <CardHeader
          title="Your plants"
          action={
            <Link to="/plants/new">
              <Button size="sm">Add plant</Button>
            </Link>
          }
        />

        {plantsLoading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : plantsError ? (
          <Alert variant="error">{getErrorMessage(plantsError)}</Alert>
        ) : !plants || plants.length === 0 ? (
          <EmptyState
            title="No plants yet"
            description="Add your first plant to get started."
            action={
              <Link to="/plants/new">
                <Button>Add plant</Button>
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {plants.slice(0, 8).map((plant) => (
              <Link
                key={plant.id}
                to={`/plants/${plant.id}`}
                className="group block rounded-lg border border-primary-100/70 bg-paper/60 p-4 transition-all hover:border-primary-400 hover:bg-paper hover:shadow-journal"
              >
                <div className="aspect-square rounded-md bg-parchment mb-3 overflow-hidden ring-1 ring-primary-100/50">
                  {plant.imageUrl ? (
                    <img
                      src={plant.imageUrl}
                      alt={`Photo of ${plant.name}`}
                      width={200}
                      height={200}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <svg
                        className="h-12 w-12 text-primary-300"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1}
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 21c-2-2-5-3-5-8 0-3 2-5 5-5s5 2 5 5c0 5-3 6-5 8z"
                        />
                      </svg>
                    </div>
                  )}
                </div>
                <p className="text-sm font-medium text-ink truncate">{plant.name}</p>
                {plant.location && (
                  <p className="text-xs text-gray-500 truncate">{plant.location}</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </Card>

      {/* Year-in-review summary */}
      <ClimateCard />

      <YearInReviewCard />

      {/* Recent activity */}
      <Card variant="paper" padding="none">
        <div className="px-6 py-5 border-b border-primary-100/70 space-y-3">
          <CardHeader
            title="Recent activity"
            description="What's been happening in your household"
          />
          {activity && activity.length > 0 && (
            <div role="group" aria-label="Filter activity" className="flex flex-wrap gap-2">
              {(['all', 'tasks', 'plants', 'people'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setActivityFilter(f)}
                  aria-pressed={activityFilter === f}
                  className={clsx(
                    'rounded-full px-3 py-1 text-xs font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    activityFilter === f
                      ? 'bg-primary-100 text-primary-800 border-primary-400'
                      : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
                  )}
                >
                  {filterLabels[f]}
                </button>
              ))}
            </div>
          )}
        </div>
        {!activity || activity.length === 0 ? (
          <div className="p-8 text-center">
            <EmptyActivity className="mx-auto h-32 w-auto" />
            <p className="mt-3 text-sm text-gray-500">
              No activity yet — complete a task to see it here.
            </p>
          </div>
        ) : filteredActivity.length === 0 ? (
          <div className="p-6">
            <p className="text-sm text-gray-500">
              No {filterLabels[activityFilter].toLowerCase()} activity in the last 50 events.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-primary-100/60">
            {filteredActivity.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

interface MetricProps {
  label: string;
  value: number | null;
  emphasis?: 'alert';
}

function Metric({ label, value, emphasis }: MetricProps) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-xs uppercase tracking-[0.14em] text-gray-500">{label}</dt>
      <dd
        className={clsx(
          'font-serif text-xl text-ink leading-none',
          emphasis === 'alert' && 'text-accent-700'
        )}
      >
        {value === null ? '—' : value}
      </dd>
    </div>
  );
}

interface ActivityRowProps {
  event: import('@/services/householdService').ActivityEvent;
}

function ActivityRow({ event }: ActivityRowProps) {
  const { type, actorName, occurredAt, payload } = event;
  const icon = <CheckIcon className="h-4 w-4 text-primary-700" aria-hidden="true" />;
  let body: React.ReactNode;
  switch (type) {
    case 'task.completed':
      body = (
        <>
          <span className="font-medium">{actorName}</span> completed{' '}
          <span className="font-medium">
            {(payload as { taskType?: string }).taskType ?? 'a task'}
          </span>
        </>
      );
      break;
    case 'plant.created':
      body = (
        <>
          <span className="font-medium">{actorName}</span> added{' '}
          <span className="font-medium">
            {(payload as { plantName?: string }).plantName ?? 'a plant'}
          </span>
        </>
      );
      break;
    case 'photo.uploaded':
      body = (
        <>
          <span className="font-medium">{actorName}</span> uploaded a new photo
        </>
      );
      break;
    case 'member.joined':
      body = (
        <>
          <span className="font-medium">{actorName}</span> joined the household
        </>
      );
      break;
    case 'member.left':
      body = (
        <>
          <span className="font-medium">{actorName}</span> left the household
        </>
      );
      break;
    case 'plant.deleted':
      body = (
        <>
          <span className="font-medium">{actorName}</span> deleted a plant
        </>
      );
      break;
    default:
      body = <span className="font-medium">{actorName}</span>;
  }
  return (
    <li className="flex items-center gap-4 px-6 py-3 text-sm">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary-100 ring-1 ring-primary-200/60">
        {icon}
      </span>
      <div className="flex-1">
        <p className="text-ink">{body}</p>
        <p className="text-xs text-gray-600">{new Date(occurredAt).toLocaleString()}</p>
      </div>
    </li>
  );
}

interface TaskItemProps {
  task: Task;
  onComplete: (taskId: string) => void;
  isCompleting: boolean;
}

function TaskItem({ task, onComplete, isCompleting }: TaskItemProps) {
  const overdue = isOverdue(task.nextDue);
  const style = taskTypeStyles[task.type] ?? taskTypeStyles.custom;
  const { Icon } = style;

  return (
    <li className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-parchment/60">
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
            className="text-sm font-medium text-ink hover:text-primary-700 truncate block"
          >
            {task.plantName}
          </Link>
          <p className="text-xs text-gray-600">
            <span className="font-medium">{task.customType || taskTypeLabels[task.type]}</span>
            {' • '}
            <span className={clsx(overdue && 'text-accent-700 font-medium')}>
              {formatDueDate(task.nextDue)}
            </span>
            {task.assignedToName && ` • ${task.assignedToName}`}
          </p>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onComplete(task.id)}
        disabled={isCompleting}
        leftIcon={<CheckIcon className="h-4 w-4" aria-hidden="true" />}
      >
        Done
      </Button>
    </li>
  );
}
