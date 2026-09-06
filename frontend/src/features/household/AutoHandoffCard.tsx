/**
 * Auto-handoff rule (ADR 0018) — the admin control for "a task N days overdue
 * goes up for grabs and the rest of the household is told once".
 *
 * Whether the household's plan includes it is a server fact (the plan
 * catalog publishes `householdToolkit`), so this card reads the catalog and
 * the subscription instead of hardcoding tier names. Per ADR 0010, a failed
 * or still-unknown plan read is rendered as exactly that — the current
 * setting stays visible, changes pause — never as "locked" or "included".
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { billingService } from '@/services/billingService';
import { householdService, type Household } from '@/services/householdService';
import { getErrorMessage } from '@/services/api';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';

/** The thresholds offered. 5 is the server-side floor; nothing lower is sold. */
const ESCALATION_THRESHOLDS = [5, 7, 10, 14] as const;

interface AutoHandoffCardProps {
  householdId: string;
  household: Pick<Household, 'escalateAfterDays'>;
}

export function AutoHandoffCard({ householdId, household }: AutoHandoffCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const current = household.escalateAfterDays ?? null;
  const [draft, setDraft] = useState<number | null>(current);
  const [saved, setSaved] = useState(false);

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (days: number | null) => householdService.setEscalationRule(householdId, days),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ['household', householdId] });
    },
  });

  // Three-state plan read (ADR 0010): in flight, known, or unknown — the
  // rolling-deploy case where an older catalog lacks the flag is "unknown".
  const checking = plansQuery.isLoading || subscriptionQuery.isLoading;
  const plan =
    plansQuery.data && subscriptionQuery.data
      ? plansQuery.data.plans.find((p) => p.id === subscriptionQuery.data.planId)
      : undefined;
  const available: boolean | undefined = plan?.householdToolkit;

  const currentSummary =
    current === null
      ? t('household.autoHandoff.currentOff')
      : t('household.autoHandoff.currentOn', { count: current });

  return (
    <Card>
      <CardHeader
        title={t('household.autoHandoff.title')}
        description={t('household.autoHandoff.description')}
      />
      {checking ? (
        <div className="flex items-center gap-2 text-sm text-gray-600" role="status">
          <LoadingSpinner size="sm" />
          {t('household.autoHandoff.checking')}
        </div>
      ) : available === undefined ? (
        <div className="space-y-2">
          <Alert variant="warning">{t('household.autoHandoff.checkFailed')}</Alert>
          <p className="text-sm text-gray-700">{currentSummary}</p>
        </div>
      ) : !available ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">{t('household.autoHandoff.locked')}</p>
          <Link
            to="/pricing"
            className="inline-flex min-h-touch items-center rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            {t('household.autoHandoff.lockedAction')}
          </Link>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            mutation.mutate(draft);
          }}
        >
          <label className="block space-y-1">
            <span className="label">{t('household.autoHandoff.thresholdLabel')}</span>
            <select
              className="input"
              value={draft === null ? '' : String(draft)}
              onChange={(event) => {
                setSaved(false);
                setDraft(event.target.value === '' ? null : Number(event.target.value));
              }}
            >
              <option value="">{t('household.autoHandoff.off')}</option>
              {ESCALATION_THRESHOLDS.map((days) => (
                <option key={days} value={days}>
                  {t('household.autoHandoff.days', { count: days })}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-gray-600">{t('household.autoHandoff.guardrails')}</p>
          <div className="flex items-center gap-3">
            <Button type="submit" isLoading={mutation.isPending} disabled={draft === current}>
              {t('common.save')}
            </Button>
            {saved && (
              <span className="text-sm text-primary-800" role="status">
                {t('household.autoHandoff.saved')}
              </span>
            )}
          </div>
          {mutation.isError && <Alert variant="error">{getErrorMessage(mutation.error)}</Alert>}
        </form>
      )}
    </Card>
  );
}
