import { useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '@/services/plantService';
import { toast, useToastStore } from '@/store/toastStore';
import { taskTypeLabels } from '@/utils/taskTypeConfig';
import { useCompleteTaskMutation } from '@/features/tasks/taskMutations';
import { UNDO_WINDOW_MS, deferredCareQueue } from './deferredCare';

type DoneTask = Pick<Task, 'id' | 'plantId' | 'nextDue' | 'type'> & {
  customType?: string | null;
};

/**
 * Marking a task done with a 5-second Undo, wherever it happens (the Plants
 * list, the plant page's status card and its task rows). Nothing is written
 * until the window has passed; Undo inside it writes nothing. One shared
 * queue (deferredCare.ts), so a task pending on one screen is pending on all
 * of them, and can never be completed twice.
 *
 * Run the plant's house-rule gate before calling `schedule`, as every Done
 * button does.
 */
export function useDeferredCompletion(householdId: string | null) {
  const { t } = useTranslation();
  const queue = deferredCareQueue();
  const pending = useSyncExternalStore(queue.subscribe, queue.pending, queue.pending);
  const completeMutation = useCompleteTaskMutation(householdId);
  const toastIds = useRef(new Map<string, number>());

  const taskName = (task: Pick<Task, 'type'> & { customType?: string | null }) =>
    task.customType || t(`tasks.types.${task.type}`, taskTypeLabels[task.type] ?? task.type);

  const dismissToast = (taskId: string) => {
    const id = toastIds.current.get(taskId);
    if (id !== undefined) useToastStore.getState().dismiss(id);
    toastIds.current.delete(taskId);
  };

  const undo = (taskId: string) => {
    dismissToast(taskId);
    if (!queue.undo(taskId)) toast.info(t('plants.list.undoTooLate'));
  };

  /** Starts the window; false when this task is already pending. */
  const schedule = (task: DoneTask, plantName: string): boolean => {
    const accepted = queue.schedule(
      { taskId: task.id, plantId: task.plantId, expectedNextDue: task.nextDue },
      (item) => {
        dismissToast(item.taskId);
        completeMutation.mutate({ taskId: item.taskId, expectedNextDue: item.expectedNextDue });
      }
    );
    // The haptic plays when the completion is written (the mutation's
    // success), so an undone tap never buzzed as done.
    if (!accepted) return false;
    const id = toast.success(
      t('plants.list.doneToast', { task: taskName(task), plant: plantName }),
      {
        durationMs: UNDO_WINDOW_MS,
        action: { label: t('plants.list.undo'), onAction: () => undo(task.id) },
      }
    );
    toastIds.current.set(task.id, id);
    return true;
  };

  return { pending, schedule, undo, taskName };
}
