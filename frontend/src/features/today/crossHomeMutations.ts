/**
 * Complete / claim / unclaim for rows on the cross-home Today page. Each
 * mutation addresses the row's OWN household (an explicit `X-Household-Id`
 * inside crossHomeTodayService), patches the `['me', 'today']` cache with
 * the server's answer, and marks that home's own household-keyed caches
 * stale for their next mount — the same "don't refetch an eventually-
 * consistent list right now" rule as features/tasks/taskMutations.ts.
 *
 * Hooks and pure cache patches only; the row components live in the page.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Task } from '@/services/plantService';
import {
  CROSS_HOME_TODAY_QUERY_KEY,
  crossHomeTodayService,
  type CrossHomeToday,
  type CrossHomeTodayRow,
} from '@/services/crossHomeTodayService';
import { getErrorMessage } from '@/services/api';
import { toast } from '@/store/toastStore';

export interface RowTarget {
  householdId: string;
  task: CrossHomeTodayRow;
}

/** A completed row leaves the queue: this is today's work, not the schedule. */
export function removeRow(
  today: CrossHomeToday,
  householdId: string,
  taskId: string
): CrossHomeToday {
  return {
    ...today,
    households: today.households.map((h) =>
      h.status === 'ok' && h.householdId === householdId
        ? { ...h, tasks: h.tasks.filter((t) => t.id !== taskId) }
        : h
    ),
  };
}

/**
 * Replace a row with the authoritative task the server returned (claim /
 * unclaim), keeping the home label the server's Task shape does not carry.
 */
export function patchRow(
  today: CrossHomeToday,
  householdId: string,
  updated: Task
): CrossHomeToday {
  return {
    ...today,
    households: today.households.map((h) =>
      h.status === 'ok' && h.householdId === householdId
        ? {
            ...h,
            tasks: h.tasks.map((t) =>
              t.id === updated.id
                ? { ...t, ...updated, householdId: t.householdId, householdName: t.householdName }
                : t
            ),
          }
        : h
    ),
  };
}

function markHomeStale(queryClient: QueryClient, householdId: string): void {
  for (const queryKey of [
    ['tasks', householdId],
    ['plants', householdId],
    ['household', householdId, 'activity'],
  ]) {
    queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
  }
}

export function useCrossHomeCompleteMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, task }: RowTarget) =>
      crossHomeTodayService.completeTask(householdId, task.id, task.nextDue),
    onSuccess: (_updated, { householdId, task }) => {
      queryClient.setQueryData<CrossHomeToday>(CROSS_HOME_TODAY_QUERY_KEY, (old) =>
        old ? removeRow(old, householdId, task.id) : old
      );
      markHomeStale(queryClient, householdId);
      toast.success(t('today.completedToast', { plant: task.plantName, name: task.householdName }));
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
}

function useRowPatchMutation(
  run: (householdId: string, taskId: string) => Promise<Task>,
  successMessage: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, task }: RowTarget) => run(householdId, task.id),
    onSuccess: (updated, { householdId }) => {
      queryClient.setQueryData<CrossHomeToday>(CROSS_HOME_TODAY_QUERY_KEY, (old) =>
        old ? patchRow(old, householdId, updated) : old
      );
      markHomeStale(queryClient, householdId);
      toast.success(successMessage);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
}

export function useCrossHomeClaimMutation() {
  const { t } = useTranslation();
  return useRowPatchMutation(
    (householdId, taskId) => crossHomeTodayService.claimTask(householdId, taskId),
    t('tasks.claimedToast')
  );
}

export function useCrossHomeUnclaimMutation() {
  const { t } = useTranslation();
  return useRowPatchMutation(
    (householdId, taskId) => crossHomeTodayService.unclaimTask(householdId, taskId),
    t('tasks.unclaimedToast')
  );
}
