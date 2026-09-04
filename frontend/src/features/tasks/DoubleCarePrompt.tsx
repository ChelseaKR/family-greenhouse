import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useDoubleCareStore } from '@/store/doubleCareStore';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { toast } from '@/store/toastStore';
import { useCompleteTaskMutation } from './taskMutations';
import { describeDuplicate } from './doubleCare';

/**
 * "Already done <when> by <name> — log it anyway?" Rendered once in the
 * Layout; every completion mutation feeds it through the double-care store,
 * so the dashboard, tasks page and plant page all get the same prompt with
 * no per-page wiring. Confirming re-submits with `confirmDuplicate: true`.
 */
export function DoubleCarePrompt() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const pending = useDoubleCareStore((s) => s.pending);
  const clear = useDoubleCareStore((s) => s.clear);
  const confirm = useCompleteTaskMutation(householdId);

  const message = pending ? describeDuplicate(pending.details, t) : '';

  return (
    <ConfirmDialog
      isOpen={pending !== null}
      onClose={() => {
        if (confirm.isPending) return;
        clear();
        toast.info(t('doubleCare.notLogged'));
      }}
      onConfirm={() => {
        if (!pending) return;
        confirm.mutate(
          {
            taskId: pending.taskId,
            expectedNextDue: pending.expectedNextDue,
            confirmDuplicate: true,
          },
          { onSettled: () => clear() }
        );
      }}
      title={t('doubleCare.title')}
      message={message}
      confirmLabel={t('doubleCare.logAnyway')}
      cancelLabel={t('doubleCare.dontLog')}
      variant="primary"
      isLoading={confirm.isPending}
    />
  );
}
