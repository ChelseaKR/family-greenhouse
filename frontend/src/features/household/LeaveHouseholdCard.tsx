import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRightStartOnRectangleIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuthStore } from '@/store/authStore';
import { toast } from '@/store/toastStore';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import {
  householdService,
  type HouseholdMember,
  type LeaveHouseholdResult,
} from '@/services/householdService';
import { taskService } from '@/services/taskService';
import { predictedRosterRefusal, readLeaveRefusal, type LeaveRefusalCode } from './leaveHousehold';

interface LeaveHouseholdCardProps {
  householdId: string;
  householdName: string;
  members: HouseholdMember[];
}

/**
 * Leave this household without deleting the account (#686).
 *
 * Its own confirm flow, as AccountSettings' header always said it should have:
 * leaving one household is not account deletion and should not sit behind
 * that friction wall. The server decides every refusal; the card predicts the
 * two the roster already shows (only member, only admin) so it never offers a
 * button the server will refuse, and handles the server's coded 409s anyway.
 *
 * The one refusal the card cannot predict is billing: an admin of a household
 * whose paid plan will renew is asked to acknowledge that leaving does not
 * cancel it — shown as a second dialog whose confirm re-sends with the
 * acknowledgement.
 */
export function LeaveHouseholdCard({
  householdId,
  householdName,
  members,
}: LeaveHouseholdCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [refusal, setRefusal] = useState<LeaveRefusalCode | null>(null);

  const predicted = predictedRosterRefusal(user?.id, members);

  // Only fetched once the dialog is open: it exists to tell the leaver, before
  // they confirm, how many tasks go back up for grabs. Until it settles (or if
  // it fails) the dialog says so without a number — never "0".
  const userId = user?.id ?? null;
  const heldTasks = useQuery({
    queryKey: ['tasks', householdId, 'assignedTo', userId],
    queryFn: () => taskService.getTasks({ assignedTo: userId ?? undefined }),
    enabled: confirmOpen && userId !== null,
  });

  const leaveMutation = useMutation({
    mutationFn: (acknowledgeBilling: boolean) =>
      householdService.leaveHousehold(householdId, { acknowledgeBilling }),
    onSuccess: async (result: LeaveHouseholdResult) => {
      setConfirmOpen(false);
      setBillingOpen(false);
      // The default-household claim may have moved server-side. Refresh the
      // token first so the next request does not carry the stale claim; the
      // 401 interceptor still recovers if this fails.
      const { refreshToken, setTokens, setUser, setHousehold, setActiveHouseholdId } =
        useAuthStore.getState();
      if (refreshToken) {
        try {
          const tokens = await authService.refreshToken(refreshToken);
          setTokens(tokens.idToken, tokens.accessToken, tokens.refreshToken);
        } catch {
          // fall through — the interceptor catches up on the next 401.
        }
      }
      setActiveHouseholdId(null);
      if (result.defaultHouseholdId && result.defaultHouseholdRole) {
        setHousehold(result.defaultHouseholdId, result.defaultHouseholdRole);
      } else if (user) {
        setUser({ ...user, householdId: null, householdRole: null });
      }
      queryClient.invalidateQueries();
      toast.success(t('household.leave.left', { household: householdName }));
      navigate(result.defaultHouseholdId ? '/dashboard' : '/onboarding', { replace: true });
    },
    onError: (error) => {
      const code = readLeaveRefusal(error);
      if (code === 'BILLING_ACK_REQUIRED') {
        setConfirmOpen(false);
        setBillingOpen(true);
        return;
      }
      setConfirmOpen(false);
      setBillingOpen(false);
      setRefusal(code);
    },
  });

  const count = heldTasks.isSuccess ? heldTasks.data.length : null;
  const tasksLine =
    count === null
      ? t('household.leave.confirmTasksUnknown')
      : count === 0
        ? ''
        : t('household.leave.confirmTasks', { count });
  const confirmMessage = [t('household.leave.confirmMessage'), tasksLine].filter(Boolean).join(' ');

  const shownRefusal = refusal ?? predicted;

  return (
    <Card>
      <CardHeader
        title={t('household.leave.title')}
        description={t('household.leave.description', { household: householdName })}
      />
      {shownRefusal === 'LAST_MEMBER' && (
        <Alert variant="info" className="mb-4">
          {t('household.leave.blockedLastMember')}
        </Alert>
      )}
      {shownRefusal === 'LAST_ADMIN' && (
        <Alert variant="info" className="mb-4">
          {t('household.leave.blockedLastAdmin')}
        </Alert>
      )}
      {leaveMutation.isError && readLeaveRefusal(leaveMutation.error) === null && (
        <Alert variant="error" className="mb-4">
          {getErrorMessage(leaveMutation.error)}
        </Alert>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          setRefusal(null);
          setConfirmOpen(true);
        }}
        disabled={predicted !== null}
        leftIcon={<ArrowRightStartOnRectangleIcon className="h-4 w-4" aria-hidden="true" />}
      >
        {t('household.leave.button')}
      </Button>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => leaveMutation.mutate(false)}
        title={t('household.leave.confirmTitle', { household: householdName })}
        message={confirmMessage}
        confirmLabel={t('household.leave.confirmLabel')}
        cancelLabel={t('household.leave.cancel')}
        isLoading={leaveMutation.isPending && !billingOpen}
      />
      <ConfirmDialog
        isOpen={billingOpen}
        onClose={() => setBillingOpen(false)}
        onConfirm={() => leaveMutation.mutate(true)}
        title={t('household.leave.billingTitle')}
        message={t('household.leave.billingMessage')}
        confirmLabel={t('household.leave.billingConfirm')}
        cancelLabel={t('household.leave.cancel')}
        isLoading={leaveMutation.isPending && billingOpen}
      />
    </Card>
  );
}
