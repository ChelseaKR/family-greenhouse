import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CheckIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { billingService, Plan, PlanId } from '@/services/billingService';
import { getErrorMessage } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { IS_BETA, BETA_NOTICE } from '@/lib/betaMode';
import clsx from 'clsx';

export function BillingSettings() {
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.householdRole === 'admin';
  const [searchParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const status = searchParams.get('status');
    if (status === 'success') setNotice('Subscription activated. Thanks for supporting the app!');
    if (status === 'cancel') setNotice('Checkout cancelled — no changes were made.');
  }, [searchParams]);

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subQuery = useQuery({
    queryKey: ['subscription', user?.householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!user?.householdId,
  });

  const checkout = useMutation({
    mutationFn: (planId: Exclude<PlanId, 'seedling'>) => billingService.startCheckout(planId),
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
        <p className="text-sm text-gray-600">
          Your household is on the{' '}
          <span className="font-medium">
            {plans.find((p) => p.id === currentPlanId)?.name ?? 'Seedling'}
          </span>{' '}
          plan
          {subQuery.data?.status === 'trialing' && ' (free trial)'}.
        </p>
        {!IS_BETA && isAdmin && subQuery.data?.stripeCustomerId && (
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            current={plan.id === currentPlanId}
            isAdmin={isAdmin}
            beta={IS_BETA}
            onSelect={(id) => {
              if (id === 'seedling') return;
              checkout.mutate(id);
            }}
            isLoading={checkout.isPending && checkout.variables === plan.id}
          />
        ))}
      </div>
    </div>
  );
}

interface PlanCardProps {
  plan: Plan;
  current: boolean;
  isAdmin: boolean;
  beta: boolean;
  onSelect: (id: PlanId) => void;
  isLoading: boolean;
}

function PlanCard({ plan, current, isAdmin, beta, onSelect, isLoading }: PlanCardProps) {
  return (
    <Card
      className={clsx('flex flex-col', current && 'border-primary-500 ring-1 ring-primary-500')}
    >
      <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
      <p className="mt-1 text-sm text-gray-500">{plan.description}</p>
      <p className="mt-4 text-3xl font-bold">
        {plan.monthlyPrice === 0 ? 'Free' : `$${plan.monthlyPrice.toFixed(2)}`}
        {plan.monthlyPrice > 0 && (
          <span className="text-base font-normal text-gray-500"> / month</span>
        )}
      </p>
      <ul className="mt-4 flex-1 space-y-2 text-sm text-gray-600">
        <li className="flex gap-2">
          <CheckIcon className="h-5 w-5 text-primary-700" aria-hidden="true" />
          Up to {plan.maxPlants} plants
        </li>
        <li className="flex gap-2">
          <CheckIcon className="h-5 w-5 text-primary-700" aria-hidden="true" />
          {plan.maxMembers === 1
            ? '1 household member'
            : `Up to ${plan.maxMembers} household members`}
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
