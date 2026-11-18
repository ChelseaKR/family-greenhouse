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
import { useRef } from 'react';
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
import { playHaptic } from '@/services/nativeHaptics';
import { noteCareDoneInBackground } from '@/services/nativeReview';
import { toast, useToastStore } from '@/store/toastStore';
import { describeDuplicate, readDuplicateCare } from '@/features/tasks/doubleCare';

export interface RowTarget {
  householdId: string;
  task: CrossHomeTodayRow;
  /** Double-care: the member saw the notice and chose to log it anyway. */
  confirmDuplicate?: boolean;
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

/**
 * Completing a row, including the double-care round trip.
 *
 * When someone else logged the same care a little earlier, the server holds
 * the completion back (409 DUPLICATE_CARE; nothing is logged) and its message
 * is written for an API client ("Send confirmDuplicate: true ..."). That text
 * is never shown. The notice is worded here from the structured details, in
 * the same words the rest of the app uses, and carries a "Log it anyway"
 * button that sends the completion again, confirmed, to the row's own home.
 *
 * The notice is a toast, so it times out. The row is still in the queue and
 * tapping Done again brings the same offer back, which is the durable route
 * the toast store asks every action to have.
 */
export function useCrossHomeCompleteMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // The open offer for each row, so a second tap replaces it instead of
  // stacking another, and a completion clears it.
  const offers = useRef(new Map<string, number>());
  const clearOffer = (taskId: string) => {
    const id = offers.current.get(taskId);
    if (id !== undefined) useToastStore.getState().dismiss(id);
    offers.current.delete(taskId);
  };

  const mutation = useMutation({
    mutationFn: ({ householdId, task, confirmDuplicate }: RowTarget) =>
      crossHomeTodayService.completeTask(
        householdId,
        task.id,
        task.nextDue,
        confirmDuplicate ? { confirmDuplicate: true } : undefined
      ),
    onSuccess: (_updated, { householdId, task, confirmDuplicate }) => {
      clearOffer(task.id);
      queryClient.setQueryData<CrossHomeToday>(CROSS_HOME_TODAY_QUERY_KEY, (old) =>
        old ? removeRow(old, householdId, task.id) : old
      );
      markHomeStale(queryClient, householdId);
      playHaptic('completed');
      noteCareDoneInBackground();
      toast.success(
        confirmDuplicate
          ? t('doubleCare.loggedAnyway')
          : t('today.completedToast', { plant: task.plantName, name: task.householdName })
      );
    },
    onError: (err, { householdId, task }) => {
      const duplicate = readDuplicateCare(err);
      if (!duplicate) {
        toast.error(getErrorMessage(err));
        return;
      }
      clearOffer(task.id);
      offers.current.set(
        task.id,
        toast.info(describeDuplicate(duplicate, t), {
          action: {
            label: t('doubleCare.logAnyway'),
            onAction: () => {
              offers.current.delete(task.id);
              mutation.mutate({ householdId, task, confirmDuplicate: true });
            },
          },
        })
      );
    },
  });
  return mutation;
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
