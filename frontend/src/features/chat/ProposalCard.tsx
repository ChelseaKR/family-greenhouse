import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { TaskTypeIcon } from '@/components/TaskTypeIcon';
import { taskService } from '@/services/taskService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import type { ProposedReminderTask } from '@/services/chatService';

interface ProposalCardProps {
  proposal: ProposedReminderTask;
}

/**
 * Confirm card for a reminder the chat assistant PROPOSED (it never creates
 * tasks itself). "Create task" goes through the normal authenticated
 * POST /tasks — the same endpoint the Tasks page uses — so pressing it is
 * always safe, including on cards re-rendered from conversation history.
 */
export function ProposalCard({ proposal }: ProposalCardProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();

  const createMutation = useMutation({
    mutationFn: () =>
      taskService.createTask({
        plantId: proposal.plantId,
        type: proposal.type,
        customType: proposal.customType ?? undefined,
        frequency: proposal.frequencyDays,
        assignedTo: proposal.assignedTo ?? undefined,
        notes: proposal.note ?? undefined,
      }),
    onSuccess: () => {
      // Household-scoped key convention: invalidating ['tasks', hh] also
      // catches the dashboard's ['tasks', hh, 'upcoming'] sub-key.
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
    },
  });

  if (dismissed) return null;

  const typeLabel =
    proposal.type === 'custom' && proposal.customType
      ? proposal.customType
      : t(`tasks.types.${proposal.type}`);
  const created = createMutation.isSuccess;

  return (
    <div
      className="border border-primary-200 bg-primary-50 rounded-lg p-3 text-sm"
      data-testid="proposal-card"
    >
      <div className="font-medium text-gray-900 flex items-center gap-1.5">
        <TaskTypeIcon type={proposal.type} className="text-primary-700" />
        <span>
          {created
            ? t('chat.proposal.created', { type: typeLabel, plant: proposal.plantName })
            : t('chat.proposal.suggested', { type: typeLabel, plant: proposal.plantName })}
        </span>
      </div>
      <div className="text-gray-600 mt-0.5">
        {t('chat.proposal.frequency', { count: proposal.frequencyDays })}
        {proposal.assigneeName
          ? ` · ${t('chat.proposal.assignee', { name: proposal.assigneeName })}`
          : ''}
        {proposal.rationale ? ` — ${proposal.rationale}` : ''}
      </div>
      {proposal.note && <div className="text-gray-500 mt-0.5 italic">{proposal.note}</div>}
      {createMutation.isError && (
        <div className="text-red-700 mt-1" role="alert">
          {getErrorMessage(createMutation.error)}
        </div>
      )}
      {!created && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="flex min-h-touch items-center gap-1 rounded bg-primary-700 px-3 py-1 text-xs font-medium text-white hover:bg-primary-800 disabled:bg-primary-200"
          >
            <CheckCircleIcon className="h-4 w-4" />
            {t('chat.proposal.createTask')}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="flex min-h-touch items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
          >
            <XMarkIcon className="h-4 w-4" />
            {t('chat.proposal.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
