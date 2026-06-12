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
import { Task } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/services/api';
import { toast } from '@/store/toastStore';

type TasksPatch = (tasks: TaskWithCoverage[]) => TaskWithCoverage[];

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
          ? { ...task, assignedTo: user?.id ?? null, assignedToName: user?.name ?? null }
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
        task.id === taskId ? { ...task, assignedTo: null, assignedToName: null } : task
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
