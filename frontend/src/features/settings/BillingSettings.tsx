import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SparklesIcon } from '@heroicons/react/24/outline';
import { billingService, isOverPlanLimit, PlanUsage } from '@/services/billingService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { isNativeApp } from '@/lib/platform';
import { COMMERCIAL_HOLD_ACTIVE, COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';
import clsx from 'clsx';

export function BillingSettings() {
  const { t } = useTranslation();

  // Native retains its existing read-only notice. The repository commercial
  // hold now makes the web surface read-only as well.
  const native = isNativeApp();

  const householdId = useActiveHouseholdId();
  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subQuery = useQuery({
    // Plan state is per-household; the backend resolves the ACTIVE household
    // (X-Household-Id header), so the key must embed it too.
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!householdId,
  });

  if (plansQuery.isLoading || subQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const plans = plansQuery.data?.plans ?? [];
  // Fail closed if an old or malformed API response omits the status field.
  const paymentsAvailable = plansQuery.data?.paymentsAvailable === true;
  const currentPlanId = subQuery.data?.planId ?? 'seedling';
  const usage = subQuery.data?.usage;
  // Genuinely over the plan caps — only possible after a downgrade. Reads,
  // edits, and deletes all keep working; only adding is blocked server-side.
  const overLimit = isOverPlanLimit(usage);

  return (
    <div className="space-y-6">
      <Alert variant="info" className="flex items-start gap-3">
        <SparklesIcon className="h-5 w-5 flex-shrink-0 mt-0.5 text-primary-700" />
        <div>
          <p className="font-semibold">Paid plan changes are paused</p>
          <p className="mt-1 text-sm">{t('commercialHold.message')}</p>
          {COMMERCIAL_HOLD_ACTIVE && (
            <p className="mt-1 text-xs text-gray-600">
              Hold effective {COMMERCIAL_HOLD_EFFECTIVE_DATE}.
            </p>
          )}
        </div>
      </Alert>
      <Card>
        <CardHeader title="Plan status" description="View your household's current plan limits." />
        {overLimit && (
          <Alert variant="warning" title={t('settings.billing.overLimitTitle')} className="mb-4">
            <p>{t('settings.billing.overLimitBody')}</p>
          </Alert>
        )}
        <p className="text-sm text-gray-600">
          Your household is on the{' '}
          <span className="font-medium">
            {plans.find((p) => p.id === currentPlanId)?.name ?? 'Seedling'}
          </span>{' '}
          plan
          {subQuery.data?.status === 'trialing' && ' (free trial)'}.
        </p>
        {usage && <UsageMeters usage={usage} />}
        {native && (
          <p className="mt-4 text-sm text-gray-600">{t('settings.billing.nativeUnavailable')}</p>
        )}
        {!paymentsAvailable && (
          <p className="mt-4 text-sm text-gray-600">
            No purchase, upgrade, or billing-management action is currently available.
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * Ambient "n of max" meters for the household's plan caps. Bars turn red when
 * over the cap (post-downgrade) — purely informational, the server enforces.
 */
function UsageMeters({ usage }: { usage: PlanUsage }) {
  const { t } = useTranslation();
  const meters = [
    {
      label: t('settings.billing.plantsUsage', { n: usage.plantCount, max: usage.maxPlants }),
      count: usage.plantCount,
      max: usage.maxPlants,
    },
    {
      label: t('settings.billing.membersUsage', { n: usage.memberCount, max: usage.maxMembers }),
      count: usage.memberCount,
      max: usage.maxMembers,
    },
  ];
  return (
    <div className="mt-4 space-y-3" data-testid="usage-meters">
      <p className="text-sm font-medium text-gray-700">{t('settings.billing.usageTitle')}</p>
      {meters.map((m) => {
        const over = m.count > m.max;
        const pct = m.max > 0 ? Math.min(100, Math.round((m.count / m.max) * 100)) : 0;
        return (
          <div key={m.label}>
            <p className={clsx('text-xs', over ? 'text-red-600 font-medium' : 'text-gray-600')}>
              {m.label}
            </p>
            <div
              className="mt-1 h-1.5 w-full max-w-xs rounded-full bg-primary-100/60"
              role="presentation"
            >
              <div
                className={clsx('h-1.5 rounded-full', over ? 'bg-red-500' : 'bg-primary-500')}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
