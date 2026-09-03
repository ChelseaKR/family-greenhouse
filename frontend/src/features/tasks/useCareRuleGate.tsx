/**
 * Completion-time house-rule gate shared by the tasks page, the dashboard's
 * upcoming-tasks card, and the plant page. (A hook that renders a dialog,
 * kept out of CareRuleDialog.tsx so react-refresh stays happy.)
 */
import { useState } from 'react';
import type { Task } from '@/services/plantService';
import { taskTypeLabels } from '@/utils/taskTypeConfig';
import { CareRuleDialog } from './CareRuleDialog';

type GateTask = Pick<Task, 'id' | 'plantId' | 'plantName' | 'type'> & {
  customType?: string | null;
};

/**
 * The house rule to show for a plant, or null when there is none. Blank and
 * whitespace-only values count as "no rule", so nothing renders for them.
 */
export function careRuleFor(plant: { careRule?: string | null } | null | undefined): string | null {
  const rule = plant?.careRule?.trim();
  return rule ? rule : null;
}

/**
 * `request(task)` completes immediately when the plant has no house rule
 * (today's behaviour — no placeholder nag) and otherwise shows the rule and
 * waits for an explicit confirm before calling `onConfirm(task)`. Render
 * `dialog` once in the owning page.
 *
 * `ruleFor` may see a plant whose read has not settled yet: on the list pages
 * the plants query runs alongside the tasks query, so the gate is best-effort
 * there and authoritative on the plant page, where the plant is the page's
 * own read.
 */
export function useCareRuleGate<T extends GateTask>(
  ruleFor: (task: T) => string | null,
  onConfirm: (task: T) => void
) {
  const [pending, setPending] = useState<{ task: T; rule: string } | null>(null);

  const request = (task: T) => {
    const rule = ruleFor(task);
    if (!rule) {
      onConfirm(task);
      return;
    }
    setPending({ task, rule });
  };

  const confirm = () => {
    if (!pending) return;
    const { task } = pending;
    setPending(null);
    onConfirm(task);
  };

  const taskLabel = pending
    ? pending.task.customType || taskTypeLabels[pending.task.type] || pending.task.type
    : '';

  const dialog = (
    <CareRuleDialog
      isOpen={pending !== null}
      plantName={pending?.task.plantName ?? ''}
      taskLabel={taskLabel}
      careRule={pending?.rule ?? ''}
      onClose={() => setPending(null)}
      onConfirm={confirm}
    />
  );

  return { request, dialog };
}
