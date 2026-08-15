import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SparklesIcon } from '@heroicons/react/24/outline';
import {
  billingService,
  evaluatePlanLimits,
  resolvePlanUsage,
  type PlanLimitEvaluation,
  type PlanUsageDetail,
} from '@/services/billingService';
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
  const usage = resolvePlanUsage(subQuery.data);
  // Three outcomes, three messages. `over` is genuinely over the plan caps —
  // only possible after a downgrade; reads, edits, and deletes all keep
  // working, only adding is blocked server-side. `unknown` means a counter
  // didn't load: the card says so instead of staying silent, because silence
  // here reads as "you're fine".
  const limits = evaluatePlanLimits(usage);

  return (
    <div className="space-y-6">
      <Alert variant="info" className="flex items-start gap-3">
        <SparklesIcon className="h-5 w-5 shrink-0 mt-0.5 text-primary-700" />
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
        {limits.overall === 'over' && (
          <Alert variant="warning" title={t('settings.billing.overLimitTitle')} className="mb-4">
            <p>{t('settings.billing.overLimitBody')}</p>
          </Alert>
        )}
        {limits.overall === 'unknown' && (
          <Alert variant="info" title={t('settings.billing.limitUnknownTitle')} className="mb-4">
            <p>{t('settings.billing.limitUnknownBody')}</p>
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
        {usage && <UsageMeters usage={usage} limits={limits} />}
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
 * Ambient "n of max" meters for the household's plan caps. Three states per
 * row, never two: a number (including a genuine 0) with a bar, or an explicit
 * "usage unavailable" with no bar. Bars turn red when over the cap
 * (post-downgrade) — purely informational, the server enforces. The
 * over/within/unknown decision comes from the same `evaluatePlanLimits` call
 * that drives the banner, so a row and the banner cannot disagree.
 */
function UsageMeters({ usage, limits }: { usage: PlanUsageDetail; limits: PlanLimitEvaluation }) {
  const { t } = useTranslation();
  const meters = [
    {
      key: 'plants',
      label:
        usage.plantCount === null
          ? t('settings.billing.plantsUsageUnavailable', { max: usage.maxPlants })
          : t('settings.billing.plantsUsage', {
              n: usage.plantCount,
              max: usage.maxPlants,
            }),
      count: usage.plantCount,
      max: usage.maxPlants,
      state: limits.plants,
    },
    {
      key: 'members',
      label:
        usage.memberCount === null
          ? t('settings.billing.membersUsageUnavailable', { max: usage.maxMembers })
          : t('settings.billing.membersUsage', {
              n: usage.memberCount,
              max: usage.maxMembers,
            }),
      count: usage.memberCount,
      max: usage.maxMembers,
      state: limits.members,
    },
  ];
  return (
    <div className="mt-4" data-testid="usage-meters">
      <p id="billing-usage-title" className="text-sm font-medium text-gray-700">
        {t('settings.billing.usageTitle')}
      </p>
      <div className="mt-3 space-y-3" role="list" aria-labelledby="billing-usage-title">
        {meters.map((m) => {
          const available = m.state !== 'unknown' && m.count !== null;
          const over = m.state === 'over';
          const pct =
            m.count !== null && m.max > 0 ? Math.min(100, Math.round((m.count / m.max) * 100)) : 0;
          return (
            <div
              key={m.key}
              role="listitem"
              data-testid={`usage-meter-${m.key}`}
              data-state={m.state}
            >
              <p className={clsx('text-xs', over ? 'text-red-600 font-medium' : 'text-gray-600')}>
                {m.label}
              </p>
              {available && (
                <div
                  className="mt-1 h-1.5 w-full max-w-xs rounded-full bg-primary-100/60"
                  role="presentation"
                  data-testid={`usage-meter-${m.key}-bar`}
                >
                  <div
                    className={clsx('h-1.5 rounded-full', over ? 'bg-red-500' : 'bg-primary-500')}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
