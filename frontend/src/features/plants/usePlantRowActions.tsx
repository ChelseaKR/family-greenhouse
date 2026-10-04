import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Plant } from '@/services/plantService';
import { taskService, type TaskWithCoverage } from '@/services/taskService';
import { getErrorMessage } from '@/services/api';
import { playHaptic } from '@/services/nativeHaptics';
import { toast } from '@/store/toastStore';
import { careRuleFor, useCareRuleGate } from '@/features/tasks/useCareRuleGate';
import { useClaimTaskMutation } from '@/features/tasks/taskMutations';
import { useActionChooser } from './useActionChooser';
import { MovePlantsDialog } from './MovePlantsDialog';
import { useDeferredCompletion } from './useDeferredCompletion';
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
  const { pending, schedule, undo, taskName } = useDeferredCompletion(householdId);
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
  const { choose, element: chooserElement } = useActionChooser();

  const scheduleDone = (task: GateTask) => {
    schedule(task, task.plant.name);
  };

  const gate = useCareRuleGate<GateTask>((task) => careRuleFor(task.plant), scheduleDone);

  const done = (item: PlantCare) => {
    if (!item.task || pending.has(item.task.id)) return;
    gate.request({ ...item.task, plantName: item.plant.name, plant: item.plant });
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
      {chooserElement}
      {movePlant && (
        <MovePlantsDialog isOpen plant={movePlant} onClose={() => setMovePlant(null)} />
      )}
    </>
  );

  return { pending, done, undo, snooze, openMenu, taskName, elements };
}
