import { useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Plant } from '@/services/plantService';
import { taskService, type TaskWithCoverage } from '@/services/taskService';
import { getErrorMessage } from '@/services/api';
import { hasNativePresent } from '@/lib/platform';
import { playHaptic } from '@/services/nativeHaptics';
import { toast, useToastStore } from '@/store/toastStore';
import { taskTypeLabels } from '@/utils/taskTypeConfig';
import { careRuleFor, useCareRuleGate } from '@/features/tasks/useCareRuleGate';
import { useClaimTaskMutation, useCompleteTaskMutation } from '@/features/tasks/taskMutations';
import { ActionSheet, type ActionSheetRequest } from './ActionSheet';
import { MovePlantsDialog } from './MovePlantsDialog';
import { UNDO_WINDOW_MS, deferredCareQueue } from './deferredCare';
import type { PlantCare } from './plantCare';

type GateTask = TaskWithCoverage & { plant: Plant };

/**
 * Everything a Plants row can do besides opening the plant: the Water (Done)
 * button, Undo, Snooze, "I'll do it", Move, and the row's menu (a long press,
 * or More on a swipe). Render `elements` once in the page.
 *
 * Completing is deferred (deferredCare.ts): nothing is written until the
 * 5-second Undo window has passed, and an Undo inside it writes nothing.
 * The plant's house rule, if it has one, is shown first, exactly as the
 * Done buttons elsewhere do.
 */
export function usePlantRowActions(householdId: string | null, myUserId: string | undefined) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queue = deferredCareQueue();
  const pending = useSyncExternalStore(queue.subscribe, queue.pending, queue.pending);
  const completeMutation = useCompleteTaskMutation(householdId);
  const claimMutation = useClaimTaskMutation(householdId);
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
  const [movePlant, setMovePlant] = useState<Plant | null>(null);
  const [sheet, setSheet] = useState<ActionSheetRequest | null>(null);
  const answer = useRef<((id: string | null) => void) | null>(null);
  const toastIds = useRef(new Map<string, number>());

  const taskName = (task: TaskWithCoverage) =>
    task.customType || t(`tasks.types.${task.type}`, taskTypeLabels[task.type] ?? task.type);

  /** One question with a few answers: Apple's action sheet in the app, the
   *  web sheet elsewhere. Resolves the chosen id, or null for no choice. */
  const choose = (request: ActionSheetRequest, from?: Element | null): Promise<string | null> => {
    if (hasNativePresent()) {
      return import('@/services/nativePresent')
        .then(({ chooseFromMenu }) => chooseFromMenu({ ...request, from }))
        .catch(() => null);
    }
    answer.current?.(null);
    return new Promise((resolve) => {
      answer.current = resolve;
      setSheet(request);
    });
  };

  const scheduleDone = (task: GateTask) => {
    const accepted = queue.schedule(
      { taskId: task.id, plantId: task.plantId, expectedNextDue: task.nextDue },
      (item) => {
        const id = toastIds.current.get(item.taskId);
        if (id !== undefined) useToastStore.getState().dismiss(id);
        toastIds.current.delete(item.taskId);
        completeMutation.mutate({ taskId: item.taskId, expectedNextDue: item.expectedNextDue });
      }
    );
    // The haptic plays when the completion is actually written (the
    // mutation's success), not here, so an undone tap never buzzed as done.
    if (!accepted) return;
    const id = toast.success(
      t('plants.list.doneToast', { task: taskName(task), plant: task.plant.name }),
      {
        durationMs: UNDO_WINDOW_MS,
        action: { label: t('plants.list.undo'), onAction: () => undo(task.id) },
      }
    );
    toastIds.current.set(task.id, id);
  };

  const gate = useCareRuleGate<GateTask>((task) => careRuleFor(task.plant), scheduleDone);

  const done = (item: PlantCare) => {
    if (!item.task || pending.has(item.task.id)) return;
    gate.request({ ...item.task, plantName: item.plant.name, plant: item.plant });
  };

  const undo = (taskId: string) => {
    const id = toastIds.current.get(taskId);
    if (id !== undefined) useToastStore.getState().dismiss(id);
    toastIds.current.delete(taskId);
    if (!queue.undo(taskId)) toast.info(t('plants.list.undoTooLate'));
  };

  const snooze = async (item: PlantCare, from?: Element | null) => {
    const task = item.task;
    if (!task) return;
    const options = [
      { id: '1', title: t('plants.list.snooze1d') },
      { id: '3', title: t('plants.list.snooze3d') },
      { id: '7', title: t('plants.list.snooze1w') },
      { id: 'cycle', title: t('plants.list.snoozeSkip') },
    ];
    const id = await choose(
      { title: t('tasks.snooze'), options, cancel: t('common.cancel') },
      from
    );
    if (!id) return;
    snoozeMutation.mutate({ task, days: id === 'cycle' ? task.frequency : Number(id) });
  };

  const openMenu = async (item: PlantCare, from?: Element | null) => {
    const task = item.task;
    const options = [
      ...(task && !pending.has(task.id)
        ? [{ id: 'done', title: t('plants.list.doNow', { task: taskName(task) }) }]
        : []),
      ...(task && !task.assignedTo && !task.effectiveAssignee && myUserId
        ? [{ id: 'claim', title: t('plants.list.claim') }]
        : []),
      ...(task ? [{ id: 'snooze', title: `${t('tasks.snooze')}…` }] : []),
      { id: 'move', title: t('plants.list.moveTo') },
      { id: 'open', title: t('plants.list.openPlant') },
    ];
    const id = await choose({ title: item.plant.name, options, cancel: t('common.cancel') }, from);
    if (id === 'done') done(item);
    else if (id === 'claim' && task) claimMutation.mutate(task.id);
    else if (id === 'snooze') await snooze(item, from);
    else if (id === 'move') setMovePlant(item.plant);
    else if (id === 'open') navigate(`/plants/${item.plant.id}`);
  };

  const elements = (
    <>
      {gate.dialog}
      <ActionSheet
        request={sheet}
        onChoose={(id) => {
          setSheet(null);
          const resolve = answer.current;
          answer.current = null;
          resolve?.(id);
        }}
      />
      {movePlant && (
        <MovePlantsDialog isOpen plant={movePlant} onClose={() => setMovePlant(null)} />
      )}
    </>
  );

  return { pending, done, undo, snooze, openMenu, taskName, elements };
}
