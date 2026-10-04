import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  AdjustmentsHorizontalIcon,
  ArrowUturnLeftIcon,
  CalendarDaysIcon,
  CheckIcon,
  ClockIcon,
  HandRaisedIcon,
  MapPinIcon,
  MegaphoneIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
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
  useSkipCycleMutation,
  useUnclaimTaskMutation,
} from './taskMutations';
import { careRuleFor, useCareRuleGate } from './useCareRuleGate';
import { useDeferredCompletion } from '@/features/plants/useDeferredCompletion';
import { useActionChooser } from '@/features/plants/useActionChooser';
import { ToolbarMenu, type MenuGroupModel } from '@/features/plants/ToolbarMenu';
import { taskWhoText } from '@/features/plants/plantCareText';
import { ListSkeleton } from '@/components/Skeleton';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { hasNativeBarTools, hasNativeFrame } from '@/lib/platform';
import { useNativeBarTools } from '@/features/plants/useNativeBarTools';
import { screenPath } from '@/config/nativeFrame';
import {
  byDueThenName,
  checklistItems,
  dateSections,
  inSegment,
  roomSections,
  segmentCounts,
  type ChecklistItem,
  type ChecklistSection,
  type Segment,
} from './checklistModel';
import { TaskChecklist } from './TaskChecklist';
import type { SwipeAction } from './TaskRow';
import { playHaptic } from '@/services/nativeHaptics';
import { toast } from '@/store/toastStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { NativePushPrompt } from '@/components/NativePushPrompt';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { EmptyTasks } from '@/components/illustrations/EmptyTasks';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { taskTypeLabels, taskTypeStyles } from '@/utils/taskTypeConfig';
import { calendarDaysBetween, isOverdue, isToday } from '@/utils/date';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useSpaces } from '@/hooks/useSpaces';
import { buildCareRoundGroups, filterTasksForSpace, mostOverdueFirst } from './careRounds';
import { TaskLocation } from '@/components/TaskLocation';
import { plantLocationLabel } from '@/utils/spaces';

type FilterType = 'all' | 'mine' | 'overdue' | 'today' | 'week';

/**
 * How long after a completion the page may still put focus back on that
 * task's Done button. Long enough for the invalidated list to come back and
 * re-bucket the row; short enough that a background refetch minutes later
 * can never yank the caret out of somewhere else.
 */
const FOCUS_RESTORE_WINDOW_MS = 5_000;

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
  // Phones get the "Checklist": the website under 640px, and the iOS app at
  // every width (its native bars replace the page's own header). The desktop
  // website keeps the layout below.
  const isMobile = useIsMobile();
  const compact = isMobile || hasNativeFrame();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [segment, setSegment] = useState<Segment>('today');
  // The phone's filters live in the page, never in the URL: in the iOS app a
  // new query on the tab's first screen would be a new screen in its stack.
  // A link that arrives with `?filter=mine` or `?space=` still opens on it.
  const [who, setWho] = useState<'all' | 'mine' | 'open'>(
    requestedTaskFilter === 'mine' ? 'mine' : 'all'
  );
  const [spaceChoice, setSpaceChoice] = useState<string | null>(requestedSpaceFilter);
  const [groupBy, setGroupBy] = useState<'date' | 'room'>('date');
  const chooser = useActionChooser();

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
  // The same three states for the PLANTS read. `plantsById` is empty both
  // while the read is in flight and after it fails, and every task whose
  // plant is missing from it used to fall through to "Unplaced" — a
  // placement claim about every plant in the household, computed from
  // nothing, with no error anywhere on the page to contradict it (the page
  // error only binds `plantsError` when a room filter is active).
  const plantsUnavailable = Boolean(plantsError);
  const unplacedGroupName =
    spacesUnavailable || plantsUnavailable ? t('spaces.locationUnknown') : t('spaces.unplaced');
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

  // Completing a task re-buckets it — a task due today lands in Upcoming —
  // which unmounts the row the keyboard was standing on and drops focus to
  // <body>, a whole page of Tab presses from the next task. Remember which
  // task was completed and put focus back on its Done button once the list
  // has settled in its new shape.
  const doneButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusAfterComplete, setFocusAfterComplete] = useState<{
    taskId: string;
    at: number;
  } | null>(null);

  // Done waits out the same 5-second Undo window as the Plants list and the
  // plant page (useDeferredCompletion, one shared queue): nothing is written
  // until it passes, and Undo inside it writes nothing. House rule gate
  // first: a plant with a care rule shows it before anything starts.
  const deferred = useDeferredCompletion(householdId);
  const careRuleGate = useCareRuleGate<TaskWithCoverage>(
    (task) => careRuleFor(plantsById.get(task.plantId)),
    (task) => {
      deferred.schedule(task, plantsById.get(task.plantId)?.name ?? task.plantName, (id) =>
        // The row re-buckets when the completion lands: put focus back then.
        setFocusAfterComplete({ taskId: id, at: Date.now() })
      );
    }
  );
  const doneOrUndo = (task: TaskWithCoverage) =>
    deferred.pending.has(task.id) ? deferred.undo(task.id) : careRuleGate.request(task);

  useEffect(() => {
    if (!focusAfterComplete) return;
    // A completion that cost nobody their place must not move anything, and
    // the intent must not outlive the interaction that created it: the row
    // can take a moment to re-bucket, but after that this is just a stale
    // claim on the user's focus.
    if (Date.now() - focusAfterComplete.at > FOCUS_RESTORE_WINDOW_MS) {
      setFocusAfterComplete(null);
      return;
    }
    // Only ever take focus back from nobody — i.e. when the row that held it
    // has been unmounted and the browser dropped focus to <body>.
    if (document.activeElement && document.activeElement !== document.body) return;
    const button = doneButtons.current.get(focusAfterComplete.taskId);
    if (!button) return;
    button.focus();
    setFocusAfterComplete(null);
  }, [focusAfterComplete, tasks]);

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
    locationFor: (task) => {
      const plant = plantsById.get(task.plantId);
      if (plant) return plantLocationLabel(plant, spacesById, unplacedLabel);
      // No plant row to read a placement from. In flight is "we have not
      // looked yet" and says nothing; settled without one is "we cannot
      // tell". Neither is "this plant is unplaced".
      return plantsLoading && !plantsUnavailable ? null : t('spaces.locationUnknown');
    },
    onClaim: (id) => claimMutation.mutate(id),
    onUnclaim: (id) => unclaimMutation.mutate(id),
    onAsk: (task) => setAskTarget(task),
    onSkip: (task, reason) => skipMutation.mutate({ task, reason }),
    registerDone: (taskId, node) => {
      if (node) doneButtons.current.set(taskId, node);
      else doneButtons.current.delete(taskId);
    },
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

  // The round's own fallback group name carries the same distinction: with
  // the rooms (or the plants) unread, every task collapses into one group,
  // and calling that group "Unplaced" states a placement for the whole
  // household that nothing computed.
  // A care round is today's walk: only what is due now (overdue and today),
  // starting in the room with the most overdue plant. It used to take every
  // task in the filter, so the walk began with plants due next week and the
  // overdue one waited in the third room.
  const dueNowTasks = sortedTasks.filter(
    (task) => isOverdue(task.nextDue) || isToday(task.nextDue)
  );
  const careRoundGroups = useMemo(
    () =>
      mostOverdueFirst(buildCareRoundGroups(dueNowTasks, plants ?? [], spaces, unplacedGroupName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dueNowTasks derives from sortedTasks
    [plants, sortedTasks, spaces, unplacedGroupName]
  );

  const spaceCard = activeSpaceName && (
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
  );

  // ---- The phone layout ("Checklist") ----
  const phoneSpace =
    spaceChoice === 'unplaced' || (spaceChoice !== null && spacesById.has(spaceChoice))
      ? spaceChoice
      : null;
  const phoneSpaceName =
    phoneSpace === 'unplaced'
      ? t('spaces.unplaced')
      : phoneSpace
        ? (spacesById.get(phoneSpace)?.name ?? null)
        : null;
  const isMine = (task: TaskWithCoverage) =>
    task.assignedTo === user?.id || task.effectiveAssignee === user?.id;
  const isOpen = (task: TaskWithCoverage) => !task.assignedTo && !task.effectiveAssignee;
  const checklist = useMemo(
    () =>
      compact
        ? checklistItems(
            filterTasksForSpace(tasks ?? [], plants ?? [], spaces, phoneSpace).filter(
              (task) => who === 'all' || (who === 'mine' ? isMine(task) : isOpen(task))
            ),
            (task) => plantsById.get(task.plantId)?.name ?? task.plantName
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isMine reads user?.id only
    [compact, tasks, plants, spaces, phoneSpace, who, user?.id, plantsById]
  );
  const segmentItems = checklist.filter((item) => inSegment(item, segment));
  // The care round: the segment's tasks only (on Today, what is due now, never
  // next week's plants), the room with the most overdue task first.
  const roomKeyOf = (item: ChecklistItem) => {
    const spaceId = plantsById.get(item.task.plantId)?.spaceId;
    return spaceId && spacesById.has(spaceId) ? spaceId : 'unplaced';
  };
  const checklistSections: ChecklistSection[] =
    groupBy === 'room'
      ? roomSections(
          checklist,
          segment,
          roomKeyOf,
          spaces.map((space) => space.id)
        )
      : dateSections(checklist, segment);
  const roomTitle = (id: string) =>
    id === 'unplaced' ? unplacedGroupName : (spacesById.get(id)?.name ?? unplacedGroupName);
  const nextUp = checklist.filter((item) => item.days > 0).sort(byDueThenName)[0] ?? null;

  // Which claim action a task offers, and whether Ask family does: the same
  // rules as the desktop row's buttons (ClaimControls, AskFamilyButton).
  // Claim open work, give back your own, take over work that came by a space
  // default, Move Day or rotation; never ask over someone's own claim.
  const claimKindOf = (task: TaskWithCoverage): 'claim' | 'unclaim' | 'takeOver' | null => {
    if (!task.assignedTo) return 'claim';
    if (task.assignedTo === user?.id) return 'unclaim';
    if (
      task.assignmentSource === 'space_default' ||
      task.assignmentSource === 'move_day' ||
      task.assignmentSource === 'rotation'
    )
      return 'takeOver';
    return null;
  };
  const canAsk = (task: TaskWithCoverage) =>
    !isHelpRequestOpen(task) &&
    !(!!task.assignedTo && task.assignmentSource === null && task.assignedTo !== user?.id);
  const claimTitle = {
    claim: 'plants.list.claim',
    unclaim: 'tasks.unclaim',
    takeOver: 'tasks.takeOver',
  };
  const claimOrUnclaim = (task: TaskWithCoverage) => {
    if (claimKindOf(task) === 'unclaim') unclaimMutation.mutate(task.id);
    else claimMutation.mutate(task.id);
  };

  const snoozeMutation = useMutation({
    mutationFn: ({ task, days }: { task: TaskWithCoverage; days: number }) =>
      taskService.snoozeTask(task.id, days, { expectedNextDue: task.nextDue }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      playHaptic('snoozed');
      toast.info(t('plants.list.snoozedToast'));
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  /** How long, as the Plants list asks it; nothing happens without a choice. */
  const snoozeTask = async (task: TaskWithCoverage, from: Element | null) => {
    const id = await chooser.choose(
      {
        title: t('tasks.snooze'),
        options: [
          { id: '1', title: t('plants.list.snooze1d') },
          { id: '3', title: t('plants.list.snooze3d') },
          { id: '7', title: t('plants.list.snooze1w') },
          { id: 'cycle', title: t('plants.list.snoozeSkip') },
        ],
        cancel: t('common.cancel'),
      },
      from
    );
    if (!id) return;
    snoozeMutation.mutate({ task, days: id === 'cycle' ? task.frequency : Number(id) });
  };

  const swipeActionsFor = (item: ChecklistItem): SwipeAction[] => {
    const task = item.task;
    const kind = claimKindOf(task);
    return [
      ...(kind
        ? [
            {
              id: 'claim',
              label: t(claimTitle[kind]),
              Icon: kind === 'unclaim' ? ArrowUturnLeftIcon : HandRaisedIcon,
              tone: kind === 'unclaim' ? 'bg-gray-600' : 'bg-accent-600',
              run: () => claimOrUnclaim(task),
            },
          ]
        : []),
      ...(canAsk(task)
        ? [
            {
              id: 'ask',
              label: t('tasks.askFamily.button'),
              Icon: MegaphoneIcon,
              tone: 'bg-sky-700',
              run: () => setAskTarget(task),
            },
          ]
        : []),
      {
        id: 'snooze',
        label: t('tasks.snooze'),
        Icon: ClockIcon,
        tone: 'bg-gray-500',
        run: (from: Element | null) => void snoozeTask(task, from),
      },
    ];
  };

  const openTaskMenu = async (item: ChecklistItem, from: Element | null) => {
    const task = item.task;
    const name = deferred.taskName(task);
    const kind = claimKindOf(task);
    const options: { id: string; title: string }[] = [
      deferred.pending.has(task.id)
        ? { id: 'undo', title: t('plants.list.undo') }
        : { id: 'done', title: t('plants.list.doNow', { task: name }) },
    ];
    if (kind) options.push({ id: 'claim', title: t(claimTitle[kind]) });
    if (canAsk(task)) options.push({ id: 'ask', title: `${t('tasks.askFamily.button')}…` });
    options.push({ id: 'snooze', title: `${t('tasks.snooze')}…` });
    const reason = skipReasonFor(task);
    if (reason)
      options.push({
        id: 'skip',
        title: t(reason === 'rain' ? 'tasks.skipRain' : 'tasks.skipFrost'),
      });
    options.push({ id: 'open', title: t('plants.list.openPlant') });
    const id = await chooser.choose(
      { title: item.plantName, options, cancel: t('common.cancel') },
      from
    );
    if (id === 'done' || id === 'undo') doneOrUndo(task);
    else if (id === 'claim') claimOrUnclaim(task);
    else if (id === 'ask') setAskTarget(task);
    else if (id === 'snooze') await snoozeTask(task, from);
    else if (id === 'skip' && reason) skipMutation.mutate({ task, reason });
    else if (id === 'open') navigate(`/plants/${task.plantId}`);
  };

  const filterGroups: MenuGroupModel[] = [
    {
      title: t('plants.list.show'),
      items: [
        { id: 'who:all', label: t('tasks.list.everyone'), checked: who === 'all' },
        { id: 'who:mine', label: t('plants.list.mine'), checked: who === 'mine' },
        { id: 'who:open', label: t('tasks.upForGrabs'), checked: who === 'open' },
      ],
    },
    {
      title: t('plants.list.groupBy'),
      items: [
        { id: 'group:date', label: t('tasks.list.groupDate'), checked: groupBy === 'date' },
        { id: 'group:room', label: t('plants.list.groupRoom'), checked: groupBy === 'room' },
      ],
    },
    ...(spaces.length > 0
      ? [
          {
            title: t('plants.list.spaces'),
            items: [
              { id: 'space:', label: t('spaces.all'), checked: phoneSpace === null },
              ...spaces.map((space) => ({
                id: `space:${space.id}`,
                label: space.name,
                checked: phoneSpace === space.id,
              })),
              {
                id: 'space:unplaced',
                label: t('spaces.unplaced'),
                checked: phoneSpace === 'unplaced',
              },
            ],
          },
        ]
      : []),
  ];
  const onFilterMenu = (id: string) => {
    const [kind, value] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (kind === 'who' && (value === 'all' || value === 'mine' || value === 'open')) setWho(value);
    else if (kind === 'group') setGroupBy(value === 'room' ? 'room' : 'date');
    else if (kind === 'space') setSpaceChoice(value || null);
    // A new filter or grouping reshapes the list: start at its top, where
    // the token that explains it sits. In the iOS app the bar does this.
    if (!hasNativeBarTools()) window.scrollTo(0, 0);
  };
  // In the iOS app the filter menu is a bar button. Its tools are filed under
  // this screen's own path, query and all, as the bar knows the screen.
  const nativeBar = compact && hasNativeBarTools();
  useNativeBarTools(
    nativeBar
      ? {
          path: screenPath(location.pathname, location.search),
          menus:
            (tasks ?? []).length > 0
              ? [
                  {
                    id: 'filter',
                    label: t('tasks.list.filter'),
                    symbol: 'line.3.horizontal.decrease.circle',
                    groups: filterGroups,
                  },
                ]
              : [],
          search: null,
        }
      : null,
    onFilterMenu,
    () => undefined
  );
  // One removable token per filter in force, so the list never shrinks
  // without saying why.
  const filterTokens = [
    who !== 'all' && {
      label: who === 'mine' ? t('plants.list.mine') : t('tasks.upForGrabs'),
      clear: () => setWho('all'),
    },
    phoneSpaceName && { label: phoneSpaceName, clear: () => setSpaceChoice(null) },
  ].filter((x): x is { label: string; clear: () => void } => Boolean(x));

  const dialogs = (
    <>
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
    </>
  );

  if (compact) {
    const settled = !isLoading && !error && tasks !== undefined;
    return (
      // In the iOS app the bar holds the title, so the list starts right
      // under it: the title row takes no room (`contents`: its h1 stays for
      // VoiceOver, visually hidden by index.css when it matches the bar).
      <div className="space-y-3 native-frame:-mt-4">
        <div className="native-frame:contents">
          <h1 className="font-serif text-3xl leading-tight text-ink">{t('tasks.title')}</h1>
        </div>
        <NativePushPrompt hasUpcomingCare={(tasks ?? []).length > 0} />
        {isLoading ? (
          <ListSkeleton rows={6} />
        ) : error ? (
          <Alert variant="error">{getErrorMessage(error)}</Alert>
        ) : (
          <TaskChecklist
            segment={segment}
            onSegment={setSegment}
            counts={segmentCounts(checklist)}
            toolbar={
              nativeBar ? null : (
                <ToolbarMenu
                  label={t('tasks.list.filter')}
                  icon={<AdjustmentsHorizontalIcon className="h-5 w-5" aria-hidden="true" />}
                  groups={filterGroups}
                  onSelect={onFilterMenu}
                />
              )
            }
            tokens={
              filterTokens.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {filterTokens.map((token) => (
                    <button
                      key={token.label}
                      type="button"
                      onClick={token.clear}
                      aria-label={t('plants.list.removeFilter', { label: token.label })}
                      className="inline-flex min-h-touch items-center gap-1 rounded-full bg-primary-100 px-3 text-sm font-semibold text-primary-800"
                    >
                      {token.label}
                      <XMarkIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : null
            }
            sections={checklistSections}
            roomTitle={roomTitle}
            householdEmpty={(tasks ?? []).length === 0}
            nextUp={nextUp}
            taskName={(item) => deferred.taskName(item.task)}
            roomOf={(item) => rowExtras.locationFor(item.task)}
            whoOf={(item) => taskWhoText(item.task, user?.id, t)}
            pending={deferred.pending}
            onCheck={(item) => doneOrUndo(item.task)}
            onMenu={(item, from) => void openTaskMenu(item, from)}
            registerCheck={rowExtras.registerDone}
            swipeActionsFor={swipeActionsFor}
            extraFor={(item) => {
              const task = item.task;
              const reason = skipReasonFor(task);
              const asked = !task.assignedTo && isHelpRequestOpen(task);
              if (!reason && !asked) return null;
              return (
                <>
                  {asked && (
                    <AskedForHelpBadge
                      name={task.helpAskedByName ?? null}
                      note={task.helpAskedNote}
                    />
                  )}
                  {reason && (
                    <ClimateSkipChip
                      reason={reason}
                      onSkip={() => skipMutation.mutate({ task, reason })}
                      isPending={skipMutation.isPending}
                    />
                  )}
                </>
              );
            }}
          />
        )}
        {/* What a segment, filter or grouping change did to the list, for a
            screen reader (#447). Empty until the read has settled. */}
        <p aria-live="polite" className="sr-only">
          {settled ? t('tasks.list.inView', { count: segmentItems.length }) : ''}
        </p>
        {chooser.element}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Today's work"
        title="Tasks"
        description="Manage your plant care tasks."
      />

      {/* The native push opt-in, at the moment it is worth something: this
          person has care on the list. Renders nothing on the web, in a build
          without push, or while native_push_enabled is off. */}
      <NativePushPrompt hasUpcomingCare={(tasks ?? []).length > 0} />

      {spaceCard}

      <div
        className="inline-flex rounded-lg border border-primary-200/70 bg-paper p-1 large-text:grid large-text:w-full large-text:grid-cols-1"
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
                    tasks: dueNowTasks.length,
                    spaces: careRoundGroups.length,
                  })}
                </p>
                {sortedTasks.length > dueNowTasks.length && (
                  <p className="mt-1 text-sm text-gray-600">
                    {t('careRounds.later', { count: sortedTasks.length - dueNowTasks.length })}
                  </p>
                )}
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
              onComplete={doneOrUndo}
              pendingTaskIds={deferred.pending}
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
              onComplete={doneOrUndo}
              pendingTaskIds={deferred.pending}
              variant="danger"
              extras={rowExtras}
            />
          )}

          {todayTasks.length > 0 && (
            <TaskSection
              title="Today"
              tasks={todayTasks}
              onComplete={doneOrUndo}
              pendingTaskIds={deferred.pending}
              extras={rowExtras}
            />
          )}

          {upcomingTasks.length > 0 && (
            <TaskSection
              title="Upcoming"
              tasks={upcomingTasks}
              onComplete={doneOrUndo}
              pendingTaskIds={deferred.pending}
              extras={rowExtras}
            />
          )}
        </div>
      )}
      {dialogs}
    </div>
  );
}

/** A placement we do not have yet is rendered as nothing at all. */
function TaskLocationOrNothing({ label }: { label: string | null }) {
  if (label === null) return null;
  return <TaskLocation label={label} />;
}

/** Claim / vacation / climate-skip plumbing shared by every section row. */
interface TaskRowExtras {
  skipReasonFor: (task: TaskWithCoverage) => Extract<SnoozeReason, 'rain' | 'frost'> | null;
  /** `null` while the plants read is still in flight: say nothing. */
  locationFor: (task: TaskWithCoverage) => string | null;
  onClaim: (taskId: string) => void;
  onUnclaim: (taskId: string) => void;
  onAsk: (task: TaskWithCoverage) => void;
  onSkip: (task: TaskWithCoverage, reason: SnoozeReason) => void;
  /** Where each row's Done button is, so focus can be put back on it. */
  registerDone: (taskId: string, node: HTMLButtonElement | null) => void;
  claimPending: boolean;
  askPending: boolean;
  skipPending: boolean;
}

interface TaskSectionProps {
  title: string;
  tasks: TaskWithCoverage[];
  /** Done, or Undo while the task is inside its Undo window. */
  onComplete: (task: TaskWithCoverage) => void;
  pendingTaskIds: ReadonlySet<string>;
  variant?: 'default' | 'danger';
  extras: TaskRowExtras;
}

function TaskSection({
  title,
  tasks,
  onComplete,
  pendingTaskIds,
  variant = 'default',
  extras,
}: TaskSectionProps) {
  const { t } = useTranslation();
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
                  <TaskLocationOrNothing label={extras.locationFor(task)} />
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
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center [&>button]:w-full sm:[&>button]:w-auto large-text:grid-cols-1">
                <ClaimControls
                  task={task}
                  onClaim={extras.onClaim}
                  onUnclaim={extras.onUnclaim}
                  isPending={extras.claimPending}
                />
                <AskFamilyButton task={task} onAsk={extras.onAsk} isPending={extras.askPending} />
                {/* Inside its Undo window the same button is Undo, so a
                    keyboard user's focus stays put and a second press undoes
                    rather than completing twice (one shared queue refuses a
                    second completion anyway). */}
                <Button
                  ref={(node) => extras.registerDone(task.id, node)}
                  variant="secondary"
                  size="sm"
                  onClick={() => onComplete(task)}
                  aria-label={
                    pendingTaskIds.has(task.id)
                      ? t('plants.list.undoAria', {
                          task: task.customType || taskTypeLabels[task.type],
                          plant: task.plantName,
                        })
                      : undefined
                  }
                  leftIcon={
                    pendingTaskIds.has(task.id) ? (
                      <ArrowUturnLeftIcon className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <CheckIcon className="h-4 w-4" aria-hidden="true" />
                    )
                  }
                >
                  {pendingTaskIds.has(task.id) ? t('plants.list.undo') : t('tasks.complete')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
