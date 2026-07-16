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
import { taskService, SnoozeReason, TaskWithCoverage } from '@/services/taskService';
import { PlantWithTasks, Task } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/services/api';
import { toast } from '@/store/toastStore';

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

/** Dashboard's upcoming list represents the current care queue: a completed
 * row leaves it immediately. Full task lists keep the recurring task and show
 * its newly scheduled due date. */
export function replaceCompletedTaskInTaskQuery(
  queryKey: readonly unknown[],
  value: unknown,
  updatedTask: Task
): unknown {
  if (Array.isArray(value) && queryKey[2] === 'upcoming') {
    return (value as TaskWithCoverage[]).filter((task) => task.id !== updatedTask.id);
  }
  return replaceCompletedTaskInCache(value, updatedTask);
}

function optimisticCompletion(task: Task): Task {
  const completedAt = new Date();
  const nextDue = new Date(completedAt);
  nextDue.setDate(nextDue.getDate() + task.frequency);
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId: string) => taskService.completeTask(taskId),
    onMutate: async (taskId: string) => {
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
    onSuccess: (updatedTask) => {
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
      toast.success('Task completed');
    },
    onError: (err, _taskId, context) => {
      context?.previousTasks.forEach(([key, value]) => queryClient.setQueryData(key, value));
      context?.previousPlants.forEach(([key, value]) => queryClient.setQueryData(key, value));
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

/** Skip-cycle snooze (one full frequency) tagged with a climate reason. */
export function useSkipCycleMutation(householdId: string | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ task, reason }: { task: Task; reason: SnoozeReason }) =>
      taskService.snoozeTask(task.id, task.frequency, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.success(t('tasks.skippedToast'));
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
}
