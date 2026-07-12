import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckIcon, SparklesIcon } from '@heroicons/react/24/outline';
import {
  billingService,
  isOverPlanLimit,
  BillingInterval,
  Plan,
  PlanId,
  PlanUsage,
} from '@/services/billingService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { IS_BETA, BETA_NOTICE } from '@/lib/betaMode';
import { isNativeApp } from '@/lib/platform';
import clsx from 'clsx';

export function BillingSettings() {
  const { t } = useTranslation();
  // Active household's role, not the stale Cognito-claim default role.
  const isAdmin = useIsHouseholdAdmin();
  const [searchParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);
  // Default to annual: it's the better value for the user and retains far
  // better for us, so it's the cadence we want to lead with.
  const [interval, setInterval] = useState<BillingInterval>('year');

  useEffect(() => {
    const status = searchParams.get('status');
    if (status === 'success') setNotice('Subscription activated. Thanks for supporting the app!');
    if (status === 'cancel') setNotice('Checkout cancelled — no changes were made.');
  }, [searchParams]);

  // App Store / Play Store compliance (Apple 3.1.1, Play Payments policy):
  // inside the native shells we sell nothing and link to no external purchase
  // flow — Stripe checkout, the Stripe portal, and upgrade CTAs are web-only.
  // Native shows the current plan + usage read-only ("reader" model).
  const native = isNativeApp();

  const householdId = useActiveHouseholdId();
  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subQuery = useQuery({
    // Subscriptions are per-household; the backend resolves the ACTIVE
    // household (X-Household-Id header), so the key must embed it too.
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!householdId,
  });

  const checkout = useMutation({
    mutationFn: (vars: { planId: Exclude<PlanId, 'seedling'>; interval: BillingInterval }) =>
      billingService.startCheckout(vars.planId, vars.interval),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
  });

  const portal = useMutation({
    mutationFn: () => billingService.openPortal(),
    onSuccess: (result) => {
      window.location.href = result.url;
    },
  });

  if (plansQuery.isLoading || subQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const plans = plansQuery.data ?? [];
  const currentPlanId = subQuery.data?.planId ?? 'seedling';
  const usage = subQuery.data?.usage;
  // Genuinely over the plan caps — only possible after a downgrade. Reads,
  // edits, and deletes all keep working; only adding is blocked server-side.
  const overLimit = isOverPlanLimit(usage);

  return (
    <div className="space-y-6">
      {IS_BETA && (
        <Alert variant="info" className="flex items-start gap-3">
          <SparklesIcon className="h-5 w-5 flex-shrink-0 mt-0.5 text-primary-700" />
          <div>
            <p className="font-semibold">Beta: no payment required.</p>
            <p className="mt-1 text-sm">{BETA_NOTICE}</p>
          </div>
        </Alert>
      )}
      <Card>
        <CardHeader title="Billing" description="Manage your household's subscription." />
        {notice && (
          <Alert variant={notice.includes('cancelled') ? 'info' : 'success'} className="mb-4">
            {notice}
          </Alert>
        )}
        {checkout.isError && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(checkout.error)}
          </Alert>
        )}
        {overLimit && (
          <Alert variant="warning" title={t('settings.billing.overLimitTitle')} className="mb-4">
            <p>{t('settings.billing.overLimitBody')}</p>
            {!native && isAdmin && subQuery.data?.stripeCustomerId && (
              <button
                type="button"
                className="mt-2 inline-flex min-h-touch items-center font-medium underline"
                onClick={() => portal.mutate()}
              >
                {t('settings.billing.manageSubscription')}
              </button>
            )}
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
        {!native && !IS_BETA && isAdmin && subQuery.data?.stripeCustomerId && (
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => portal.mutate()}
            isLoading={portal.isPending}
          >
            Manage subscription
          </Button>
        )}
      </Card>

      {!native && (
        <>
          <BillingIntervalToggle value={interval} onChange={setInterval} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:grid-cols-3">
            {plans.map((plan) => {
              // Lifetime is Garden-only. For every other tier, the Lifetime cadence
              // falls back to Annual so the card stays priced and checkout never
              // sends interval='lifetime' for a tier the backend would reject.
              const effectiveInterval: BillingInterval =
                interval === 'lifetime' && plan.lifetimePrice == null ? 'year' : interval;
              return (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  interval={effectiveInterval}
                  current={plan.id === currentPlanId}
                  isAdmin={isAdmin}
                  beta={IS_BETA}
                  onSelect={(id) => {
                    if (id === 'seedling') return;
                    checkout.mutate({ planId: id, interval: effectiveInterval });
                  }}
                  isLoading={checkout.isPending && checkout.variables?.planId === plan.id}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Monthly/Annual/Lifetime segmented toggle. Annual is the cadence we want
 * chosen, so it carries the "Save ~33%" nudge. Lifetime is a one-time payment
 * offered on Garden only — picking it leaves non-Garden cards on Annual.
 */
function BillingIntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (v: BillingInterval) => void;
}) {
  const options: { id: BillingInterval; label: string }[] = [
    { id: 'month', label: 'Monthly' },
    { id: 'year', label: 'Annual' },
    { id: 'lifetime', label: 'Lifetime' },
  ];
  return (
    <div className="flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-3">
      <div
        role="radiogroup"
        aria-label="Billing interval"
        className="inline-flex rounded-full bg-parchment p-1"
      >
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={value === opt.id}
            onClick={() => onChange(opt.id)}
            className={clsx(
              'min-h-touch rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              value === opt.id ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-600'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <span className="rounded-full bg-primary-50 px-2.5 py-1 text-xs font-medium text-primary-700">
        {value === 'lifetime' ? 'Garden only · pay once' : 'Save ~33% yearly'}
      </span>
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

interface PlanCardProps {
  plan: Plan;
  interval: BillingInterval;
  current: boolean;
  isAdmin: boolean;
  beta: boolean;
  onSelect: (id: PlanId) => void;
  isLoading: boolean;
}

function PlanCard({ plan, interval, current, isAdmin, beta, onSelect, isLoading }: PlanCardProps) {
  // Free tier: no price line variants. Annual tiers show the yearly headline
  // plus an effective "/mo billed yearly" and the savings vs 12× monthly.
  // Lifetime is a one-time charge — "$149 once" — shown only on the tier that
  // offers one (Garden). The parent already falls non-Garden cards back to
  // 'year', so `lifetime` here implies a non-null lifetimePrice.
  const lifetime = interval === 'lifetime' && plan.lifetimePrice != null;
  const annual = interval === 'year' && plan.annualPrice != null;
  const savingsPct =
    plan.annualPrice != null && plan.monthlyPrice > 0
      ? Math.round((1 - plan.annualPrice / (plan.monthlyPrice * 12)) * 100)
      : 0;
  return (
    <Card
      className={clsx('flex flex-col', current && 'border-primary-500 ring-1 ring-primary-500')}
    >
      <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
      <p className="mt-1 text-sm text-gray-500">{plan.description}</p>
      {plan.monthlyPrice === 0 ? (
        <p className="mt-4 text-3xl font-bold">Free</p>
      ) : lifetime ? (
        <div className="mt-4">
          <p className="text-3xl font-bold">
            ${plan.lifetimePrice!.toFixed(0)}
            <span className="text-base font-normal text-gray-500"> once</span>
          </p>
          <p className="mt-1 text-sm text-gray-500">One-time payment · keep Garden forever</p>
        </div>
      ) : annual ? (
        <div className="mt-4">
          <p className="text-3xl font-bold">
            ${plan.annualPrice!.toFixed(2)}
            <span className="text-base font-normal text-gray-500"> / year</span>
          </p>
          <p className="mt-1 text-sm text-gray-500">
            ${(plan.annualPrice! / 12).toFixed(2)}/mo billed yearly
            {savingsPct > 0 && (
              <span className="ml-1 font-medium text-primary-700">· save {savingsPct}%</span>
            )}
          </p>
        </div>
      ) : (
        <p className="mt-4 text-3xl font-bold">
          ${plan.monthlyPrice.toFixed(2)}
          <span className="text-base font-normal text-gray-500"> / month</span>
        </p>
      )}
      <ul className="mt-4 flex-1 space-y-2 text-sm text-gray-600">
        <li className="flex gap-2">
          <CheckIcon className="h-5 w-5 text-primary-700" aria-hidden="true" />
          Up to {plan.maxPlants} plants
        </li>
        <li className="flex gap-2">
          <CheckIcon className="h-5 w-5 text-primary-700" aria-hidden="true" />
          {`Up to ${plan.maxMembers} household members`}
        </li>
      </ul>
      <div className="mt-6">
        {current ? (
          <Button variant="secondary" disabled className="w-full">
            Current plan
          </Button>
        ) : plan.id === 'seedling' ? (
          <Button variant="secondary" disabled className="w-full">
            Free
          </Button>
        ) : beta ? (
          // Beta: checkout flow disabled until Stripe is wired and pricing
          // goes live. Show a non-interactive label instead of a dead
          // button so users don't think it's a temporary outage.
          <Button variant="secondary" disabled className="w-full">
            Free during beta
          </Button>
        ) : isAdmin ? (
          <Button className="w-full" onClick={() => onSelect(plan.id)} isLoading={isLoading}>
            Upgrade to {plan.name}
          </Button>
        ) : (
          <Button variant="secondary" disabled className="w-full">
            Admin only
          </Button>
        )}
      </div>
    </Card>
  );
}
