import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  QuestionMarkCircleIcon,
  HandRaisedIcon,
  MegaphoneIcon,
} from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { taskService, SnoozeReason, TaskWithCoverage } from '@/services/taskService';
import { plantService } from '@/services/plantService';
import { climateService } from '@/services/climateService';
import { householdService, type ActivityEvent } from '@/services/householdService';
import { deriveClimateSignals, climateSkipSuggestion } from '@/features/tasks/climateSignals';
import {
  AskedForHelpBadge,
  ClaimControls,
  ClimateSkipChip,
  CoveringBadge,
  UpForGrabsBadge,
} from '@/features/tasks/taskRowExtras';
import { isHelpRequestOpen } from '@/features/tasks/helpRequest';
import {
  useClaimTaskMutation,
  useCompleteTaskMutation,
  useSkipCycleMutation,
  useUnclaimTaskMutation,
} from '@/features/tasks/taskMutations';
import { careRuleFor, useCareRuleGate } from '@/features/tasks/useCareRuleGate';
import { useOverdueAlerts } from '@/hooks/useOverdueAlerts';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { YearInReviewCard } from './YearInReviewCard';
import { ClimateCard } from './ClimateCard';
import { MoveDayCard } from './MoveDayCard';
import { SharedCarePulse } from './SharedCarePulse';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { PageHeader } from '@/components/PageHeader';
import { PlantGridSkeleton, ListSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { EmptyActivity } from '@/components/illustrations/EmptyActivity';
import { Alert } from '@/components/Alert';
import { SprigDivider } from '@/components/brand/SprigDivider';
import { DashboardHeaderArt } from '@/components/headers/DashboardHeaderArt';
import { PlantImage } from '@/components/PlantImage';
import { useSpaces } from '@/hooks/useSpaces';
import { plantLocationLabel } from '@/utils/spaces';
import { TaskLocation } from '@/components/TaskLocation';
import { getErrorMessage } from '@/services/api';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { taskTypeLabels, taskTypeStyles } from '@/utils/taskTypeConfig';
import { formatDueDate, isOverdue } from '@/utils/date';
import { filterActivity, type ActivityFilter } from './activityFeed';

const filterLabels: Record<ActivityFilter, string> = {
  all: 'All',
  tasks: 'Tasks',
  plants: 'Plants',
  people: 'People',
};

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const { householdId, householdQuery } = useActiveHousehold();

  const {
    data: upcomingTasks,
    isLoading: tasksLoading,
    error: tasksError,
  } = useQuery({
    queryKey: ['tasks', householdId, 'upcoming'],
    queryFn: taskService.getUpcomingTasks,
    enabled: Boolean(householdId),
  });
  const { byId: spacesById, unavailable: spacesUnavailable } = useSpaces();
  // A failed rooms read must not render as "Unplaced" — that is a placement
  // claim nobody computed. `locationUnknown` says which of the two it is.
  const unplacedLabel = spacesUnavailable ? t('spaces.locationUnknown') : t('spaces.unplaced');

  const {
    data: plants,
    isLoading: plantsLoading,
    error: plantsError,
  } = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
    enabled: Boolean(householdId),
  });

  useOverdueAlerts(upcomingTasks, householdId);

  const {
    data: activity,
    isLoading: activityLoading,
    error: activityError,
  } = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'activity'],
      // Pull a wider window so client-side filters have something to chew on;
      // 50 keeps round-trip light while making the "Plants" or "People" pills
      // feel non-empty even when watering dominates the feed.
      (hh) => householdService.getActivity(hh, 50)
    )
  );

  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const filteredActivity = useMemo(
    () => filterActivity(activity ?? [], activityFilter).slice(0, 10),
    [activity, activityFilter]
  );

  const completeTaskMutation = useCompleteTaskMutation(householdId);

  const handleCompleteTask = async (task: TaskWithCoverage) => {
    try {
      await completeTaskMutation.mutateAsync({
        taskId: task.id,
        expectedNextDue: task.nextDue,
      });
    } catch {
      // Error is handled by the mutation
    }
  };

  // Same climate query the ClimateCard below issues (shared key → one
  // fetch); powers the "Rain expected — skip this cycle?" chips on rows.
  const { data: climate } = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'climate'],
      (hh) => climateService.getClimate(hh),
      { staleTime: 30 * 60 * 1000 }
    )
  );
  const climateSignals = deriveClimateSignals(climate);
  const plantsById = useMemo(() => new Map((plants ?? []).map((p) => [p.id, p])), [plants]);
  // House rule gate (see useCareRuleGate): shows the plant's care rule before
  // a completion goes through; with no rule the click completes as before.
  const careRuleGate = useCareRuleGate<TaskWithCoverage>(
    (task) => careRuleFor(plantsById.get(task.plantId)),
    (task) => void handleCompleteTask(task)
  );
  const placementForTask = (task: TaskWithCoverage) => {
    const spaceId = plantsById.get(task.plantId)?.spaceId;
    return spaceId ? spacesById.get(spaceId) : undefined;
  };

  const claimMutation = useClaimTaskMutation(householdId);
  const unclaimMutation = useUnclaimTaskMutation(householdId);
  const skipMutation = useSkipCycleMutation(householdId);

  const overdueTasks = upcomingTasks?.filter((task) => isOverdue(task.nextDue)) || [];
  const todayTasks =
    upcomingTasks?.filter(
      (task) => !isOverdue(task.nextDue) && formatDueDate(task.nextDue) === 'Today'
    ) || [];
  const laterTasks =
    upcomingTasks?.filter(
      (task) => !isOverdue(task.nextDue) && formatDueDate(task.nextDue) !== 'Today'
    ) || [];

  // `undefined` data covers loading AND a failed fetch. Keying on the loading
  // flag alone published a failed plants/tasks read as the number 0 — "you
  // have no plants", "nothing is overdue" — which is the same
  // absence-as-zero the plan meters had (#308). No data means no number: the
  // metric renders an em dash instead of a reassuring zero.
  const plantCount = plants === undefined ? null : plants.length;
  const todayCount = upcomingTasks === undefined ? null : todayTasks.length;
  const overdueCount = upcomingTasks === undefined ? null : overdueTasks.length;

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
      {/* `mt-10` replaces a `-mt-4` that never actually applied. Tailwind v3
          implemented `space-y-10` as a margin-TOP on each later sibling, which
          outranked this element's own `-mt-4`, so the row has always sat 40px
          below the header. v4 implements the same utility as a margin-BOTTOM on
          each earlier sibling, leaving margin-top free — which let the stale
          `-mt-4` take effect and pulled the row up 24px. Stating the 40px
          directly keeps the shipped spacing and no longer depends on which
          side of the gap the space-y utility happens to own. */}
      <dl className="flex flex-wrap items-baseline gap-x-4 sm:gap-x-8 gap-y-3 mt-10 text-sm">
        <Metric label="Plants" value={plantCount} />
        <Metric label="Due today" value={todayCount} />
        <Metric
          label="Overdue"
          value={overdueCount}
          emphasis={overdueCount && overdueCount > 0 ? 'alert' : undefined}
        />
      </dl>

      <SharedCarePulse />

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
          <div className="px-6 py-2">
            <ListSkeleton rows={4} />
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
                locationLabel={
                  plantsById.has(task.plantId)
                    ? plantLocationLabel(plantsById.get(task.plantId)!, spacesById, unplacedLabel)
                    : unplacedLabel
                }
                onComplete={careRuleGate.request}
                isCompleting={
                  completeTaskMutation.isPending &&
                  completeTaskMutation.variables?.taskId === task.id
                }
                skipReason={climateSkipSuggestion(task, placementForTask(task), climateSignals)}
                onSkip={(t, reason) => skipMutation.mutate({ task: t, reason })}
                skipPending={skipMutation.isPending}
                onClaim={(id) => claimMutation.mutate(id)}
                onUnclaim={(id) => unclaimMutation.mutate(id)}
                claimPending={claimMutation.isPending || unclaimMutation.isPending}
              />
            ))}
          </ul>
        )}
      </Card>
      {careRuleGate.dialog}

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
          <PlantGridSkeleton count={8} />
        ) : plantsError ? (
          <Alert variant="error">{getErrorMessage(plantsError)}</Alert>
        ) : !plants || plants.length === 0 ? (
          <EmptyState
            title="Let's add your first plant"
            description="Name it, or start from a species suggestion and we'll fill in the care details. We'll handle the watering reminders from there."
            action={
              <Link to="/plants/new">
                <Button size="lg">Add your first plant</Button>
              </Link>
            }
            hint="Takes less than a minute."
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {plants.slice(0, 8).map((plant) => (
              <Link
                key={plant.id}
                to={`/plants/${plant.id}`}
                className="group block rounded-lg border border-primary-100/70 bg-paper/60 p-4 transition-all hover:border-primary-400 hover:bg-paper hover:shadow-journal"
              >
                <div className="aspect-square rounded-md bg-parchment mb-3 overflow-hidden ring-1 ring-primary-100/50">
                  <PlantImage
                    plant={plant}
                    width={200}
                    height={200}
                    className="transition-transform group-hover:scale-105"
                  />
                </div>
                <p className="text-sm font-medium text-ink truncate">{plant.name}</p>
                <p className="text-xs text-gray-600 truncate">
                  {plantLocationLabel(plant, spacesById, unplacedLabel)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {/* Seasonal Move Day — renders only when a list exists */}
      <MoveDayCard />

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
                    'min-h-touch rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500',
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
        {activityLoading ? (
          <div className="px-6 py-2">
            <ListSkeleton rows={4} />
          </div>
        ) : activityError ? (
          // A failed feed read is not an empty feed. Rendering "No activity
          // yet" here told a household whose fetch 500'd that nothing had
          // happened — the sibling tasks and plants cards already separate
          // these states; the activity card was the one that didn't.
          <div className="p-6">
            <Alert variant="error">{getErrorMessage(activityError)}</Alert>
          </div>
        ) : !activity || activity.length === 0 ? (
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
      <dt className="text-xs uppercase tracking-[0.14em] text-gray-600">{label}</dt>
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
  event: ActivityEvent;
}

function ActivityRow({ event }: ActivityRowProps) {
  const { t } = useTranslation();
  const { actorName, occurredAt } = event;
  let icon = <CheckIcon className="h-4 w-4 text-primary-700" aria-hidden="true" />;
  let iconTone = 'bg-primary-100 ring-primary-200/60';
  let body: React.ReactNode;

  switch (event.type) {
    case 'task.completed':
      body = (
        <>
          <span className="font-medium">{actorName}</span> completed{' '}
          <span className="font-medium">{event.payload.taskType ?? 'a task'}</span>
        </>
      );
      break;
    case 'task.snoozed': {
      // "snoozed water for Monstera (rain expected)" — the climate skip
      // reasons read as why the cycle was skipped.
      const p = event.payload;
      const reasonLabel =
        p.reason === 'rain'
          ? 'rain expected'
          : p.reason === 'frost'
            ? 'frost expected'
            : p.reason === 'heat'
              ? 'heat wave'
              : null;
      body = (
        <>
          <span className="font-medium">{actorName}</span> snoozed{' '}
          <span className="font-medium">{p.taskType ?? 'a task'}</span>
          {p.plantName && <> for {p.plantName}</>}
          {reasonLabel && <> ({reasonLabel})</>}
        </>
      );
      break;
    }
    case 'task.claimed':
    case 'task.unclaimed': {
      const p = event.payload;
      body = (
        <>
          <span className="font-medium">{actorName}</span>{' '}
          {event.type === 'task.claimed' ? 'claimed' : 'released'}{' '}
          <span className="font-medium">{p.taskType ?? 'a task'}</span>
          {p.plantName && <> for {p.plantName}</>}
        </>
      );
      break;
    }
    case 'plant.created':
      body = (
        <>
          <span className="font-medium">{actorName}</span> added{' '}
          <span className="font-medium">{event.payload.plantName ?? 'a plant'}</span>
        </>
      );
      break;
    case 'plants.imported': {
      const p = event.payload;
      const count =
        typeof p.count === 'number' && Number.isInteger(p.count) && p.count > 0 ? p.count : null;
      body =
        count === null
          ? t('activity.importedUnknown', { actor: actorName })
          : t('activity.imported', { actor: actorName, count });
      break;
    }
    case 'plant.propagated': {
      const p = event.payload;
      body = t('activity.propagated', {
        actor: actorName,
        plant: p.plantName ?? t('activity.aPlant'),
        parent: p.parentPlantName ?? t('activity.anotherPlant'),
      });
      break;
    }
    case 'plant.shared_accepted': {
      const p = event.payload;
      body = t('activity.sharedAccepted', {
        actor: actorName,
        plant: p.plantName ?? t('activity.aPlant'),
        household: p.fromHouseholdName ?? t('activity.anotherHousehold'),
      });
      break;
    }
    case 'plant.health_checked': {
      const p = event.payload;
      const overall =
        p.overall === 'healthy' || p.overall === 'monitor' || p.overall === 'concern'
          ? p.overall
          : null;
      const plant = p.plantName ?? t('activity.aPlant');
      if (p.demo) {
        icon = <InformationCircleIcon className="h-4 w-4 text-amber-700" aria-hidden="true" />;
        iconTone = 'bg-amber-50 ring-amber-200';
        body = t('activity.healthDemo', { actor: actorName, plant });
      } else if (p.demo === false && overall) {
        if (overall === 'monitor') {
          icon = <InformationCircleIcon className="h-4 w-4 text-amber-700" aria-hidden="true" />;
          iconTone = 'bg-amber-50 ring-amber-200';
        } else if (overall === 'concern') {
          icon = <ExclamationTriangleIcon className="h-4 w-4 text-red-700" aria-hidden="true" />;
          iconTone = 'bg-red-50 ring-red-200';
        }
        body = t('activity.healthChecked', {
          actor: actorName,
          plant,
          overall: t(`plants.leafHealth.overall.${overall}`),
        });
      } else if (p.demo === false) {
        // A real check whose verdict this build can't render. The check
        // itself is still an established fact, so the row may state it.
        icon = <InformationCircleIcon className="h-4 w-4 text-gray-600" aria-hidden="true" />;
        iconTone = 'bg-gray-100 ring-gray-200';
        body = t('activity.healthCheckedUnknown', { actor: actorName, plant });
      } else {
        // No `demo` flag at all: rows written before the flag was recorded
        // (#306) cannot be told apart from demo results. "Ran a leaf-health
        // check" would assert an analysis that may never have happened, so
        // the row states the request and admits the provenance is unknown.
        icon = <QuestionMarkCircleIcon className="h-4 w-4 text-gray-600" aria-hidden="true" />;
        iconTone = 'bg-gray-100 ring-gray-200';
        body = t('activity.healthCheckedUnlabelled', { actor: actorName, plant });
      }
      break;
    }
    case 'task.schedule_matched': {
      const p = event.payload;
      body = t('activity.scheduleMatched', {
        actor: actorName,
        task: p.taskType ?? t('activity.aTask'),
        plant: p.plantName ?? t('activity.aPlant'),
        from: p.previousFrequency,
        to: p.newFrequency,
      });
      break;
    }
    case 'plant.archived':
    case 'plant.restored':
    case 'plant.died':
    case 'plant.gave_away': {
      const p = event.payload;
      const verb = {
        'plant.archived': 'archived',
        'plant.restored': 'restored',
        'plant.died': 'recorded the loss of',
        'plant.gave_away': 'recorded giving away',
      }[event.type];
      body = (
        <>
          <span className="font-medium">{actorName}</span> {verb}{' '}
          <span className="font-medium">{p.plantName ?? 'a plant'}</span>
        </>
      );
      break;
    }
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
    case 'sitter_link.created':
    case 'sitter_link.revoked': {
      // Any member can open a sitter link now, so the feed names who did and
      // until when — the household's view of who holds a door open.
      const p = event.payload;
      const label = p.label ?? t('household.sitterLinks.untitled');
      body =
        event.type === 'sitter_link.created'
          ? t('activity.sitterLinkCreated', {
              actor: actorName,
              label,
              end: new Date(p.expiresAt).toLocaleDateString(),
            })
          : t('activity.sitterLinkRevoked', { actor: actorName, label });
      break;
    }
    case 'upgrade.requested': {
      const p = event.payload;
      // Feature ids resolve through the LockedFeature catalog; an id this
      // build does not know (older/newer row) falls back to the plain form
      // rather than printing a raw key.
      const featureKey = `locked.features.${p.feature}`;
      body = i18n.exists(featureKey)
        ? t('activity.upgradeRequested', { actor: actorName, feature: t(featureKey) })
        : t('activity.upgradeRequestedUnknown', { actor: actorName });
      break;
    }
    case 'plant.deleted':
      body = (
        <>
          <span className="font-medium">{actorName}</span> deleted a plant
        </>
      );
      break;
    case 'task.help_requested': {
      // A PERSON asked (ADR 0024) — unlike task.escalated this row has an
      // actor, and their note is the reason the ask beats a silent unclaim.
      const p = event.payload;
      icon = <MegaphoneIcon className="h-4 w-4 text-amber-700" aria-hidden="true" />;
      iconTone = 'bg-amber-50 ring-amber-200';
      const task = p.taskType ?? t('activity.aTask');
      const plant = p.plantName ?? t('activity.aPlant');
      const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null;
      body = (
        <>
          {t('activity.helpRequested', { actor: actorName, task, plant })}
          {note && <span className="italic"> {t('activity.helpRequestedNote', { note })}</span>}
        </>
      );
      break;
    }
    case 'task.escalated': {
      // System-authored: the row must not lead with an actor name (it is
      // empty). The copy names the lapse, not a person — nobody is blamed.
      const p = event.payload;
      icon = <HandRaisedIcon className="h-4 w-4 text-amber-700" aria-hidden="true" />;
      iconTone = 'bg-amber-50 ring-amber-200';
      const days =
        typeof p.daysOverdue === 'number' && Number.isInteger(p.daysOverdue) && p.daysOverdue > 0
          ? p.daysOverdue
          : null;
      const task = p.taskType ?? t('activity.aTask');
      const plant = p.plantName ?? t('activity.aPlant');
      body =
        days === null
          ? t('activity.escalatedUnknownDays', { task, plant })
          : t('activity.escalated', { task, plant, count: days });
      break;
    }
    case 'caretaker.note':
      // `actorName` is the caretaker's own name — attribution is the whole
      // reason caretaker seats are named rather than anonymous like a sitter
      // link, so the feed says who wrote it.
      body = t('activity.caretakerNote', { actor: actorName, note: event.payload.text });
      break;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      body = t('activity.generic', { actor: actorName });
      break;
    }
  }

  return (
    <li className="flex items-center gap-4 px-6 py-3 text-sm">
      <span
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full ring-1 ${iconTone}`}
      >
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
  task: TaskWithCoverage;
  locationLabel: string;
  onComplete: (task: TaskWithCoverage) => void;
  isCompleting: boolean;
  skipReason: Extract<SnoozeReason, 'rain' | 'frost'> | null;
  onSkip: (task: TaskWithCoverage, reason: SnoozeReason) => void;
  skipPending: boolean;
  onClaim: (taskId: string) => void;
  onUnclaim: (taskId: string) => void;
  claimPending: boolean;
}

function TaskItem({
  task,
  locationLabel,
  onComplete,
  isCompleting,
  skipReason,
  onSkip,
  skipPending,
  onClaim,
  onUnclaim,
  claimPending,
}: TaskItemProps) {
  const overdue = isOverdue(task.nextDue);
  const style = taskTypeStyles[task.type] ?? taskTypeStyles.custom;
  const { Icon } = style;

  return (
    <li className="flex flex-col gap-4 px-4 py-4 transition-colors hover:bg-parchment/60 sm:flex-row sm:items-center sm:justify-between sm:px-6">
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
          <TaskLocation label={locationLabel} />
          {(!task.assignedTo || task.coveringFor || skipReason) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {!task.assignedTo &&
                (isHelpRequestOpen(task) ? (
                  // A housemate asked (ADR 0024): say who, and show the note.
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
                  onSkip={() => onSkip(task, skipReason)}
                  isPending={skipPending}
                />
              )}
            </div>
          )}
        </div>
      </div>
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end [&>button]:w-full sm:[&>button]:w-auto">
        <ClaimControls
          task={task}
          onClaim={onClaim}
          onUnclaim={onUnclaim}
          isPending={claimPending}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onComplete(task)}
          disabled={isCompleting}
          leftIcon={<CheckIcon className="h-4 w-4" aria-hidden="true" />}
        >
          Done
        </Button>
      </div>
    </li>
  );
}
