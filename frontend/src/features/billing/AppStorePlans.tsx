import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { formatDate } from '@/i18n/format';
import type { PlanId, SubscriptionState } from '@/services/billingService';
import {
  APP_STORE_PRODUCT_IDS,
  buyPlan,
  loadStoreProducts,
  openManageSubscriptions,
  restorePurchases,
  type BuyOutcome,
  type PaidPlanId,
  type PurchaseRefusalCode,
  type RestoreOutcome,
} from '@/services/appStorePurchases';

/**
 * Settings → Plan inside the iPhone app when App Store purchases are on
 * (ADR 0041): the two paid tiers at the App Store's own prices, Apple's
 * purchase sheet, Restore purchases, and Apple's Manage Subscriptions sheet.
 *
 * Guideline 3.1.1 and 3.1.2: the prices shown are StoreKit's `displayPrice`
 * and nothing else (never the catalog's, never the website's); nothing here
 * names or links to another way to pay; the auto-renewal terms and the links
 * to the Terms of Use and Privacy Policy sit next to the buttons.
 *
 * A household that already pays through another route sees that it has a
 * paid plan and no purchase buttons, because the server would refuse a
 * second way of paying for the same home anyway (purchase intent, 409).
 */

const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
const RANK: Record<PlanId, number> = { seedling: 0, garden: 1, greenhouse: 2 };
const PAID: PaidPlanId[] = ['garden', 'greenhouse'];

/** The tier this household already has from something other than Apple, if any. */
function paidOutsideAppStore(sub: SubscriptionState | undefined): {
  stripeLive: boolean;
  includedUpTo: PlanId;
} {
  const stripeLive =
    !!sub?.stripeSubscriptionId && (!sub.status || LIVE_STRIPE_STATUSES.has(sub.status));
  let includedUpTo: PlanId = 'seedling';
  const raise = (p: PlanId | undefined) => {
    if (p && RANK[p] > RANK[includedUpTo]) includedUpTo = p;
  };
  raise(sub?.lifetimePlanId);
  if (sub?.gift?.state === 'active') raise(sub.gift.planId);
  return { stripeLive, includedUpTo };
}

function refusalKey(code: PurchaseRefusalCode): string {
  switch (code) {
    case 'ADULT_REQUIRED':
      return 'appStore.adultRequired';
    case 'APP_STORE_LINKED_ELSEWHERE':
      return 'appStore.linkedElsewhere';
    case 'APP_STORE_OTHER_SUBSCRIPTION':
      return 'appStore.otherSubscription';
    case 'APP_STORE_SUBSCRIPTION_ACTIVE':
      return 'appStore.refusedActive';
    default:
      return 'appStore.alreadyPaid';
  }
}

interface Message {
  variant: 'success' | 'error' | 'info';
  text: string;
}

interface AppStorePlansProps {
  subscription: SubscriptionState | undefined;
  isAdmin: boolean;
  planNames: Partial<Record<PlanId, string>>;
}

export function AppStorePlans({ subscription, isAdmin, planNames }: AppStorePlansProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<Message | null>(null);
  const name = (plan: PlanId) => planNames[plan] ?? plan;

  const products = useQuery({
    queryKey: ['app-store-products'],
    queryFn: loadStoreProducts,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['subscription'] });

  const buy = useMutation({
    mutationFn: (plan: PaidPlanId) => buyPlan(plan),
    onMutate: () => setMessage(null),
    onSuccess: (outcome: BuyOutcome, plan) => {
      switch (outcome.kind) {
        case 'purchased':
          setMessage({ variant: 'success', text: t('appStore.purchased', { plan: name(plan) }) });
          void refresh();
          return;
        case 'pending':
          setMessage({ variant: 'info', text: t('appStore.pending') });
          return;
        case 'cancelled':
          return;
        case 'refused':
          setMessage({ variant: 'info', text: t(refusalKey(outcome.code)) });
          void refresh();
          return;
        case 'unavailable':
          setMessage({ variant: 'info', text: t('appStore.unavailable') });
          return;
        default:
          setMessage({ variant: 'error', text: t('appStore.failed') });
      }
    },
  });

  const restore = useMutation({
    mutationFn: restorePurchases,
    onMutate: () => setMessage(null),
    onSuccess: (outcome: RestoreOutcome) => {
      switch (outcome.kind) {
        case 'restored':
          setMessage({
            variant: 'success',
            text: t('appStore.restored', {
              plan: outcome.appStore ? name(outcome.appStore.planId) : '',
            }),
          });
          void refresh();
          return;
        case 'nothing':
          setMessage({ variant: 'info', text: t('appStore.nothingToRestore') });
          return;
        case 'refused':
          setMessage({ variant: 'info', text: t(refusalKey(outcome.code)) });
          return;
        default:
          setMessage({ variant: 'error', text: t('appStore.restoreFailed') });
      }
    },
  });

  const appStore = subscription?.appStore;
  const appStoreActive = appStore?.state === 'active';
  const { stripeLive, includedUpTo } = paidOutsideAppStore(subscription);
  const busy = buy.isPending || restore.isPending;

  let body: ReactNode;
  if (appStoreActive && appStore) {
    body = (
      <div className="mt-4 space-y-3">
        <p className="text-sm text-ink" data-testid="app-store-active">
          {t(appStore.willRenew === false ? 'appStore.activeEnds' : 'appStore.activeRenews', {
            plan: name(appStore.planId),
            date: formatDate(appStore.expiresAt),
          })}
        </p>
        <Button variant="secondary" onClick={() => void openManageSubscriptions()}>
          {t('appStore.manage')}
        </Button>
      </div>
    );
  } else if (stripeLive || includedUpTo === 'greenhouse') {
    body = (
      <p className="mt-4 text-sm text-gray-600" data-testid="app-store-paid-elsewhere">
        {stripeLive
          ? t('appStore.alreadyPaid')
          : t('appStore.alreadyIncluded', { plan: name(includedUpTo) })}
      </p>
    );
  } else if (products.isPending) {
    body = (
      <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
        <LoadingSpinner size="sm" />
        <span>{t('appStore.loading')}</span>
      </div>
    );
  } else if (!products.data || PAID.every((p) => !products.data[p])) {
    body = (
      <p className="mt-4 text-sm text-gray-600" data-testid="app-store-products-unavailable">
        {t('appStore.productsUnavailable')}
      </p>
    );
  } else {
    const offered = PAID.filter((p) => RANK[p] > RANK[includedUpTo] && products.data[p]);
    body = (
      <ul className="mt-4 space-y-3">
        {offered.map((plan) => {
          const product = products.data[plan]!;
          return (
            <li
              key={plan}
              className="flex flex-col gap-2 rounded-lg border border-primary-100 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`app-store-plan-${plan}`}
              data-product-id={APP_STORE_PRODUCT_IDS[plan]}
            >
              <div>
                <p className="font-serif text-lg text-ink">{product.displayName || name(plan)}</p>
                <p className="text-sm text-gray-700">
                  {t('appStore.perMonth', { price: product.displayPrice })}
                </p>
              </div>
              <Button
                onClick={() => buy.mutate(plan)}
                isLoading={buy.isPending && buy.variables === plan}
                disabled={!isAdmin || busy}
              >
                {t('appStore.subscribe', { plan: product.displayName || name(plan) })}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader title={t('appStore.title')} description={t('appStore.description')} />
      {message && (
        <Alert variant={message.variant} className="mt-4">
          <p>{message.text}</p>
        </Alert>
      )}
      {body}
      {!isAdmin && !appStoreActive && (
        <p className="mt-3 text-sm text-gray-600">{t('appStore.adminOnly')}</p>
      )}
      <div className="mt-4">
        <Button
          variant="secondary"
          onClick={() => restore.mutate()}
          isLoading={restore.isPending}
          disabled={busy}
        >
          {t('appStore.restore')}
        </Button>
      </div>
      <p className="mt-4 text-xs text-gray-600">{t('appStore.disclosure')}</p>
      <p className="mt-2 flex gap-4 text-xs">
        <Link to="/legal/terms" className="underline">
          {t('appStore.terms')}
        </Link>
        <Link to="/legal/privacy" className="underline">
          {t('appStore.privacy')}
        </Link>
      </p>
    </Card>
  );
}
