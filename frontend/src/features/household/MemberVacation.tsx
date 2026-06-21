/**
 * Per-member vacation control for the household members list.
 *
 * Shows the member's vacation window when one exists (active or upcoming)
 * with a cancel action, otherwise a "Set vacation" toggle that expands an
 * inline date-range + covered-by form. Visibility mirrors the API rules:
 * you can manage your own window; admins can manage anyone's.
 *
 * Data: one `['tasks', hh, 'vacations']` query shared by every row (same
 * key → a single fetch), mutations invalidate it plus the task lists so
 * "Covering for X" badges refresh immediately.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { taskService, VacationWindow } from '@/services/taskService';
import { HouseholdMember } from '@/services/householdService';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { toast } from '@/store/toastStore';

/** YYYY-MM-DD (date input) → ISO datetime; start-of-day / end-of-day UTC. */
function toStartIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}
function toEndIso(date: string): string {
  return `${date}T23:59:59.000Z`;
}

interface MemberVacationProps {
  householdId: string;
  member: HouseholdMember;
  members: HouseholdMember[];
  /** Caller may manage this member's window (self or admin). */
  canManage: boolean;
  window: VacationWindow | undefined;
}

export function MemberVacation({
  householdId,
  member,
  members,
  canManage,
  window: vacationWindow,
}: MemberVacationProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const coverOptions = members.filter((m) => m.userId !== member.userId);
  const [coveredBy, setCoveredBy] = useState(coverOptions[0]?.userId ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const invalidate = () => {
    // Vacations + task lists (the "Covering for X" badges live on tasks).
    queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
  };

  const setMutation = useMutation({
    mutationFn: () =>
      taskService.setVacation({
        userId: member.userId,
        coveredBy,
        startDate: toStartIso(startDate),
        endDate: toEndIso(endDate),
      }),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
    },
    // Without this a rejected setVacation (e.g. endDate before startDate, or a
    // non-admin setting cover for someone else → 403) failed silently: the form
    // just stayed open with no feedback. Mirror cancelMutation's toast.
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: () => taskService.cancelVacation(member.userId),
    onSuccess: invalidate,
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (vacationWindow) {
    const nowIso = new Date().toISOString();
    const upcoming = vacationWindow.startDate > nowIso;
    const endLabel = new Date(vacationWindow.endDate).toLocaleDateString();
    const startLabel = new Date(vacationWindow.startDate).toLocaleDateString();
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-300/70">
          {upcoming
            ? t('household.vacation.startsOn', { date: startLabel })
            : t('household.vacation.onVacationUntil', { date: endLabel })}
          {vacationWindow.coveredByName && (
            <>
              {' · '}
              {t('household.vacation.coveredByName', { name: vacationWindow.coveredByName })}
            </>
          )}
        </span>
        {canManage && (
          <button
            type="button"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
            className="text-xs font-medium text-accent-700 hover:underline disabled:opacity-50"
          >
            {t('household.vacation.cancelWindow')}
          </button>
        )}
      </div>
    );
  }

  if (!canManage) return null;

  if (!formOpen) {
    return (
      <button
        type="button"
        onClick={() => setFormOpen(true)}
        className="mt-1 text-xs font-medium text-primary-700 hover:underline"
      >
        {t('household.vacation.setVacation')}
      </button>
    );
  }

  if (coverOptions.length === 0) {
    return <p className="mt-1 text-xs text-gray-600">{t('household.vacation.noCoverOptions')}</p>;
  }

  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-primary-100 bg-primary-50/50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!coveredBy || !startDate || !endDate) return;
        setMutation.mutate();
      }}
    >
      <p className="text-xs text-gray-600">{t('household.vacation.description')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-xs font-medium text-gray-700">
          {t('household.vacation.startDateLabel')}
          <input
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="input mt-1 block text-sm"
          />
        </label>
        <label className="block text-xs font-medium text-gray-700">
          {t('household.vacation.endDateLabel')}
          <input
            type="date"
            required
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => setEndDate(e.target.value)}
            className="input mt-1 block text-sm"
          />
        </label>
        <label className="block text-xs font-medium text-gray-700">
          {t('household.vacation.coveredByLabel')}
          <select
            value={coveredBy}
            onChange={(e) => setCoveredBy(e.target.value)}
            className="input mt-1 block text-sm"
          >
            {coverOptions.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          isLoading={setMutation.isPending}
          disabled={!coveredBy || !startDate || !endDate}
        >
          {t('household.vacation.save')}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setFormOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
      {setMutation.isError && <Alert variant="error">{getErrorMessage(setMutation.error)}</Alert>}
    </form>
  );
}
