/**
 * Claim / unclaim / skip-cycle mutations shared by TasksPage and the
 * dashboard's upcoming-tasks card. (Hooks live here, presentational pieces
 * in taskRowExtras.tsx, so react-refresh stays happy.)
 *
 * Claim/unclaim optimistically patch every `['tasks', hh, …]` query (the
 * list and the dashboard's 'upcoming' variant share the prefix) and
 * invalidate the same prefix on settle, per the household-scoped query-key
 * convention.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  taskService,
  type AskFamilyResult,
  type SnoozeReason,
  type TaskWithCoverage,
} from '@/services/taskService';
import { PlantWithTasks, Task } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/services/api';
import { toast } from '@/store/toastStore';
import { useDoubleCareStore } from '@/store/doubleCareStore';
import { readDuplicateCare } from './doubleCare';

export interface CompleteTaskVariables {
  taskId: string;
  expectedNextDue: string;
  /** Double-care: the member saw the notice and chose to log it anyway. */
  confirmDuplicate?: boolean;
}

type TasksPatch = (tasks: TaskWithCoverage[]) => TaskWithCoverage[];

type CachedQuerySnapshot = Array<[readonly unknown[], unknown]>;

function replaceTask(tasks: TaskWithCoverage[], updatedTask: Task): TaskWithCoverage[] {
  return tasks.map((task) => (task.id === updatedTask.id ? { ...task, ...updatedTask } : task));
}

/**
 * Patch either task-list data or a plant-detail response with the authoritative
 * task returned by POST /tasks/:id/complete. Keeping this pure makes the
 * eventual-consistency regression independently testable.
 */
export function replaceCompletedTaskInCache(value: unknown, updatedTask: Task): unknown {
  if (Array.isArray(value)) {
    return replaceTask(value as TaskWithCoverage[], updatedTask);
  }
  if (value && typeof value === 'object') {
    const plant = value as PlantWithTasks;
    if (Array.isArray(plant.upcomingTasks)) {
      return { ...plant, upcomingTasks: replaceTask(plant.upcomingTasks, updatedTask) };
    }
  }
  return value;
}

/**
 * A completed row does NOT leave the dashboard's upcoming list — it moves to
 * its next due date, exactly as every other task list shows it.
 *
 * This used to filter the row out, on the reasoning that the upcoming list is
 * "the current care queue". The server disagrees: `getUpcomingTasks` returns
 * everything due within SEVEN DAYS (`services/taskService.ts`), and completing
 * a task advances `nextDue` by its frequency. So any task recurring every
 * seven days or fewer — which is most watering — lands straight back inside
 * the window and the refetch returns it.
 *
 * The row therefore vanished on tap and reappeared a moment later, which reads
 * as "it didn't save". Observed in production: a household tapped done seven
 * times in fifty seconds against a 3-day and a 7-day watering task. Every tap
 * had persisted — there were seven completion rows to prove it.
 *
 * Removing a row the server is about to send back is the optimistic-update
 * equivalent of rendering a guess as the answer. Showing the new due date is
 * both true and self-explanatory: the task moves rather than flickering.
 */
export function replaceCompletedTaskInTaskQuery(
  _queryKey: readonly unknown[],
  value: unknown,
  updatedTask: Task
): unknown {
  return replaceCompletedTaskInCache(value, updatedTask);
}

/**
 * Reproduce the server's next-due arithmetic EXACTLY.
 *
 * `backend/src/services/taskService.ts` (`completeTask`) computes
 * `nextDue.setDate(nextDue.getDate() + frequency)` in the process zone, and
 * the deployed Lambdas run in UTC (no `TZ` is set anywhere in
 * `infrastructure/`; `backend/vitest.config.ts` pins the same). `setDate` /
 * `getDate` here run in the BROWSER's zone, so across a DST transition the
 * two disagree by an hour — enough to move the rendered calendar date a
 * whole day. The optimistic row then showed one date and visibly jumped to
 * another when `onSuccess` swapped in the authoritative value: a guess
 * rendered as the schedule.
 *
 * `setUTCDate` is identical to what the server computes under TZ=UTC, for
 * every browser zone. It does not fix the underlying "a due date is an
 * instant, not a calendar date in the household's zone" design problem
 * (#342) — it only stops the client from publishing a different answer than
 * the one the server is about to write.
 */
function optimisticCompletion(task: Task): Task {
  const completedAt = new Date();
  const nextDue = new Date(completedAt);
  nextDue.setUTCDate(nextDue.getUTCDate() + task.frequency);
  return {
    ...task,
    lastCompleted: completedAt.toISOString(),
    nextDue: nextDue.toISOString(),
  };
}

function findTaskInSnapshots(snapshots: CachedQuerySnapshot, taskId: string): Task | undefined {
  for (const [, value] of snapshots) {
    if (Array.isArray(value)) {
      const task = (value as Task[]).find((candidate) => candidate.id === taskId);
      if (task) return task;
    }
    if (value && typeof value === 'object') {
      const task = (value as Partial<PlantWithTasks>).upcomingTasks?.find(
        (candidate) => candidate.id === taskId
      );
      if (task) return task;
    }
  }
  return undefined;
}

export function useCompleteTaskMutation(householdId: string | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, expectedNextDue, confirmDuplicate }: CompleteTaskVariables) =>
      taskService.completeTask(
        taskId,
        confirmDuplicate ? { expectedNextDue, confirmDuplicate } : { expectedNextDue }
      ),
    onMutate: async ({ taskId }: CompleteTaskVariables) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['tasks', householdId] }),
        queryClient.cancelQueries({ queryKey: ['plants', householdId] }),
      ]);

      const previousTasks = queryClient.getQueriesData({
        queryKey: ['tasks', householdId],
      }) as CachedQuerySnapshot;
      const previousPlants = queryClient.getQueriesData({
        queryKey: ['plants', householdId],
      }) as CachedQuerySnapshot;
      const cachedTask = findTaskInSnapshots([...previousTasks, ...previousPlants], taskId);

      if (cachedTask) {
        const optimisticTask = optimisticCompletion(cachedTask);
        previousTasks.forEach(([key, value]) =>
          queryClient.setQueryData(key, replaceCompletedTaskInTaskQuery(key, value, optimisticTask))
        );
        queryClient.setQueriesData({ queryKey: ['plants', householdId] }, (value: unknown) =>
          replaceCompletedTaskInCache(value, optimisticTask)
        );
      }

      return { previousTasks, previousPlants };
    },
    onSuccess: (updatedTask, variables) => {
      // The mutation response is strongly authoritative. Do not immediately
      // replace it with an eventually consistent list/GSI read, which can
      // briefly return the old nextDue and make the completion look inert.
      queryClient
        .getQueriesData({ queryKey: ['tasks', householdId] })
        .forEach(([key, value]) =>
          queryClient.setQueryData(key, replaceCompletedTaskInTaskQuery(key, value, updatedTask))
        );
      queryClient.setQueriesData({ queryKey: ['plants', householdId] }, (value: unknown) =>
        replaceCompletedTaskInCache(value, updatedTask)
      );
      toast.success(variables.confirmDuplicate ? t('doubleCare.loggedAnyway') : 'Task completed');
    },
    onError: (err, variables, context) => {
      context?.previousTasks.forEach(([key, value]) => queryClient.setQueryData(key, value));
      context?.previousPlants.forEach(([key, value]) => queryClient.setQueryData(key, value));
      // Double-care: the server held the completion back (nothing was logged)
      // and said who did it first. The rollback above already undid the
      // optimistic advance; hand the decision to the prompt instead of an
      // error toast. Confirming re-submits with `confirmDuplicate: true`.
      const duplicate = readDuplicateCare(err);
      if (duplicate && !variables.confirmDuplicate) {
        useDoubleCareStore.getState().prompt({
          taskId: variables.taskId,
          expectedNextDue: variables.expectedNextDue,
          details: duplicate,
        });
        return;
      }
      toast.error(getErrorMessage(err));
    },
    onSettled: () => {
      // Mark related views stale for the next mount/focus without triggering
      // the immediate eventually-consistent refetch that caused this bug.
      queryClient.invalidateQueries({
        queryKey: ['tasks', householdId],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: ['plants', householdId],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: ['household', householdId, 'activity'],
        refetchType: 'none',
      });
    },
  });
}

function useOptimisticTasksMutation(
  householdId: string | null,
  mutationFn: (taskId: string) => Promise<Task>,
  patchFor: (taskId: string) => TasksPatch,
  successMessage: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (taskId: string) => {
      await queryClient.cancelQueries({ queryKey: ['tasks', householdId] });
      const previous = queryClient.getQueriesData<TaskWithCoverage[]>({
        queryKey: ['tasks', householdId],
      });
      const patch = patchFor(taskId);
      queryClient.setQueriesData<TaskWithCoverage[]>({ queryKey: ['tasks', householdId] }, (old) =>
        old ? patch(old) : old
      );
      return { previous };
    },
    onError: (err, _taskId, context) => {
      // Roll the optimistic patch back before surfacing the error (e.g. the
      // 409 "Already claimed" race loss).
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error(getErrorMessage(err));
    },
    onSuccess: () => toast.success(successMessage),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['tasks', householdId] }),
  });
}

export function useClaimTaskMutation(householdId: string | null) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  return useOptimisticTasksMutation(
    householdId,
    (taskId) => taskService.claimTask(taskId),
    (taskId) => (tasks) =>
      tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              assignedTo: user?.id ?? null,
              assignedToName: user?.name ?? null,
              assignmentSource: null,
            }
          : task
      ),
    t('tasks.claimedToast')
  );
}

export function useUnclaimTaskMutation(householdId: string | null) {
  const { t } = useTranslation();
  return useOptimisticTasksMutation(
    householdId,
    (taskId) => taskService.unclaimTask(taskId),
    (taskId) => (tasks) =>
      tasks.map((task) =>
        task.id === taskId
          ? { ...task, assignedTo: null, assignedToName: null, assignmentSource: null }
          : task
      ),
    t('tasks.unclaimedToast')
  );
}

export interface AskFamilyVariables {
  task: Task;
  /** The asker's optional short note; blank is sent as no note at all. */
  note?: string;
}

/**
 * "Ask family to do it" (ADR 0024).
 *
 * Deliberately NOT optimistic: the point of the feature is who got told, and
 * that answer only exists once the server has run the away/Do-Not-Disturb
 * guardrails. The toast reports it honestly — reaching nobody (a one-person
 * household, or everyone away or asleep) is a real outcome and says so
 * instead of showing a success the household never received.
 */
export function useAskFamilyMutation(householdId: string | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ task, note }: AskFamilyVariables) =>
      taskService.askFamily(task.id, note?.trim() || undefined, task.nextDue),
    onSuccess: (result: AskFamilyResult) => {
      if (result.recipients.length === 0) {
        toast.info(t('tasks.askNobodyReachable'));
      } else if (result.delivered === 0) {
        toast.info(t('tasks.askNotDelivered', { count: result.recipients.length }));
      } else {
        toast.success(t('tasks.askedToast', { count: result.delivered }));
      }
    },
    onError: (err) => toast.error(getErrorMessage(err)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      queryClient.invalidateQueries({
        queryKey: ['household', householdId, 'activity'],
        refetchType: 'none',
      });
    },
  });
}

/** Skip-cycle snooze (one full frequency) tagged with a climate reason. */
export function useSkipCycleMutation(householdId: string | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ task, reason }: { task: Task; reason: SnoozeReason }) =>
      taskService.snoozeTask(task.id, task.frequency, {
        reason,
        expectedNextDue: task.nextDue,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.success(t('tasks.skippedToast'));
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
}
