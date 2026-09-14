import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GiftIcon } from '@heroicons/react/24/outline';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { buttonStyles } from '@/components/buttonStyles';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { useAuthStore } from '@/store/authStore';
import { isNativeApp } from '@/lib/platform';
import { formatCurrency, formatDate } from '@/i18n/format';
import {
  billingService,
  type GiftPurchase,
  type Plan,
  type PlanId,
} from '@/services/billingService';

type GiftablePlanId = Exclude<PlanId, 'seedling'>;

/** How long to keep re-reading the purchase list after Stripe sends the buyer back. */
const PURCHASE_POLL_MS = 60_000;

interface ApiErrorShape {
  response?: { status?: number; data?: { details?: { code?: unknown } } };
}

function purchaseErrorKey(error: unknown): string {
  const response = (error as ApiErrorShape)?.response;
  const code = response?.data?.details?.code;
  if (response?.status === 400 && code === 'GIFT_NOT_CONFIGURED') {
    return 'giftSubscription.purchaseErrors.notConfigured';
  }
  if (response?.status === 503) return 'giftSubscription.purchaseErrors.paymentsPaused';
  return 'giftSubscription.purchaseErrors.providerUnreachable';
}

/** The tier's catalog name; the id itself when the catalog has not named it. */
function planName(plans: Plan[] | undefined, id: GiftablePlanId): string {
  return plans?.find((p) => p.id === id)?.name ?? id;
}

/** Gift total in dollars from integer cents, so 3 × $4.99 is $14.97 and not $14.970000000000002. */
function giftTotal(monthlyPrice: number, months: number): number {
  return (Math.round(monthlyPrice * 100) * months) / 100;
}

/**
 * Public /gift landing page (ADR 0028).
 *
 * The purchase flow this page exposes shipped inside Settings → Billing
 * (`GiftSubscriptionCard`) with no route a logged-out visitor — or a
 * signed-in user with no household of their own — could ever reach: buying a
 * gift for a plant-loving friend is not a reason to create your own
 * household first. This page is the door. It reuses the same
 * `giftSubscription.*` copy and the same `billingService` calls as the
 * in-app card (the "give" half only — redeeming a code changes a household's
 * plan and stays an in-app, admin-only action in Settings → Billing).
 *
 * Browsing needs no account: the catalog read (`GET /billing/plans`) is
 * public. Starting checkout needs a signed-in buyer (the backend charges
 * their card and emails their receipt) but explicitly NOT a household —
 * `POST /billing/gift/checkout` dropped its `requireHousehold` gate
 * alongside this page, because the Stripe Session it opens has never carried
 * one. A visitor who isn't signed in gets a sign-in/register prompt that
 * returns them here via the app's existing `?redirect=` convention, instead
 * of a form that would only 401 on submit.
 */
export function GiftLandingPage() {
  const { t } = useTranslation();
  const native = isNativeApp();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [searchParams] = useSearchParams();
  const returnedFromPurchase = searchParams.get('status') === 'success';

  useMetaTags({
    title: 'Send a Family Greenhouse gift subscription',
    description:
      "Pay once for months of Garden or Greenhouse for someone else's household. They get a redemption code — no household of your own required to send one.",
    canonical: siteUrl('/gift'),
  });

  if (native) {
    return (
      <PublicShell>
        <PageIntro eyebrow={t('giftLanding.eyebrow')} title={t('giftLanding.title')} />
        <p className="mt-6 text-sm leading-6 text-gray-700">{t('giftLanding.nativeNotice')}</p>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <PageIntro
        eyebrow={t('giftLanding.eyebrow')}
        title={t('giftLanding.title')}
        lede={t('giftLanding.lede')}
      />

      <section className="mt-10" aria-labelledby="gift-how-it-works-heading">
        <h2 id="gift-how-it-works-heading" className="font-serif text-xl tracking-tight text-ink">
          {t('giftLanding.howItWorksHeading')}
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {(['step1', 'step2', 'step3'] as const).map((step, i) => (
            <li
              key={step}
              className="rounded-xl border border-primary-100/70 bg-paper p-4 shadow-journal"
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-700 text-sm font-serif text-paper"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <p className="mt-3 text-sm font-semibold text-ink">{t(`giftLanding.${step}Title`)}</p>
              <p className="mt-1 text-sm leading-6 text-gray-700">{t(`giftLanding.${step}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-10">
        {isAuthenticated ? (
          <GiftPurchaseForm returnedFromPurchase={returnedFromPurchase} />
        ) : (
          <Card variant="paper">
            <CardHeader
              title={t('giftLanding.signInHeading')}
              description={t('giftLanding.signInBody')}
            />
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                to={`/register?redirect=${encodeURIComponent('/gift')}`}
                className={buttonStyles({ size: 'lg' })}
              >
                {t('giftLanding.registerCta')}
              </Link>
              <Link
                to={`/login?redirect=${encodeURIComponent('/gift')}`}
                className={buttonStyles({ variant: 'secondary', size: 'lg' })}
              >
                {t('giftLanding.signInCta')}
              </Link>
            </div>
          </Card>
        )}
      </div>
    </PublicShell>
  );
}

/**
 * The buy form + the buyer's own purchase history. Only mounted once the
 * visitor is signed in — the catalog read stays public either way, but the
 * purchase-list read (`GET /billing/gift/purchases`) requires auth and would
 * otherwise just render its own failure state for every logged-out visitor.
 */
function GiftPurchaseForm({ returnedFromPurchase }: { returnedFromPurchase: boolean }) {
  const { t } = useTranslation();

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });

  const [pollUntil] = useState(() => (returnedFromPurchase ? Date.now() + PURCHASE_POLL_MS : 0));
  const purchasesQuery = useQuery({
    queryKey: ['giftPurchases'],
    queryFn: billingService.listGiftPurchases,
    staleTime: 0,
    refetchInterval: () => (Date.now() < pollUntil ? 3000 : false),
  });

  const offer = plansQuery.data?.giftSubscriptions;
  const plans = plansQuery.data?.plans;
  const paymentsAvailable = plansQuery.data?.paymentsAvailable === true;
  const givable = offer?.plans.filter((p) => p.available && paymentsAvailable) ?? [];

  const [planId, setPlanId] = useState<GiftablePlanId | null>(null);
  const [months, setMonths] = useState(3);
  const [purchaseErrorKeyState, setPurchaseErrorKey] = useState<string | null>(null);
  const effectivePlanId = planId ?? givable[0]?.planId ?? null;
  const selectedPlan = effectivePlanId ? plans?.find((p) => p.id === effectivePlanId) : undefined;
  const monthly = selectedPlan?.monthlyPrice;
  const total = typeof monthly === 'number' ? giftTotal(monthly, months) : null;
  const canGive = effectivePlanId !== null && total !== null;

  const purchaseMutation = useMutation({
    mutationFn: () => {
      if (!effectivePlanId) throw new Error('no plan selected');
      return billingService.createGiftCheckout({
        planId: effectivePlanId,
        months,
        checkoutAttemptId: crypto.randomUUID(),
      });
    },
    onMutate: () => setPurchaseErrorKey(null),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error) => setPurchaseErrorKey(purchaseErrorKey(error)),
  });

  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (purchase: GiftPurchase) => {
    try {
      await navigator.clipboard.writeText(purchase.code);
      setCopied(purchase.stripeSessionId);
    } catch {
      setCopied(null);
    }
  };

  if (plansQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!plansQuery.data || !paymentsAvailable) {
    return <CommercialHoldNotice className="mx-auto max-w-2xl" />;
  }

  return (
    <div data-testid="gift-landing-purchase-form">
      <Card variant="paper">
        <CardHeader title={t('giftSubscription.giveTitle')} />
        {purchaseErrorKeyState && (
          <Alert
            variant="error"
            title={t('giftSubscription.purchaseErrorTitle')}
            className="mt-2 mb-2"
          >
            <p>{t(purchaseErrorKeyState)}</p>
          </Alert>
        )}
        {givable.length === 0 || !offer ? (
          <p className="mt-2 text-sm text-gray-600">{t('giftSubscription.notForSale')}</p>
        ) : (
          <div className="mt-2 space-y-3">
            <div className="flex flex-wrap gap-3">
              <div>
                <label htmlFor="gift-landing-plan" className="label">
                  {t('giftSubscription.planLabel')}
                </label>
                <select
                  id="gift-landing-plan"
                  className="input"
                  value={effectivePlanId ?? ''}
                  onChange={(e) => setPlanId(e.target.value as GiftablePlanId)}
                >
                  {givable.map((p) => (
                    <option key={p.planId} value={p.planId}>
                      {planName(plans, p.planId)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="gift-landing-months" className="label">
                  {t('giftSubscription.monthsLabel')}
                </label>
                <select
                  id="gift-landing-months"
                  className="input"
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                >
                  {Array.from(
                    { length: offer.maxMonths - offer.minMonths + 1 },
                    (_, i) => offer.minMonths + i
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n === 1
                        ? t('giftSubscription.oneMonth')
                        : t('giftSubscription.nMonths', { n })}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {total !== null && typeof monthly === 'number' && (
              <p className="text-sm font-medium text-gray-900" data-testid="gift-landing-total">
                {t('giftSubscription.total', {
                  months,
                  monthly: formatCurrency(monthly),
                  total: formatCurrency(total),
                })}
              </p>
            )}
            {total !== null && (
              <p className="text-xs text-gray-600">
                {t('giftSubscription.terms', {
                  total: formatCurrency(total),
                  days: offer.redeemWindowDays,
                  months,
                })}
              </p>
            )}
            <Button
              type="button"
              onClick={() => purchaseMutation.mutate()}
              isLoading={purchaseMutation.isPending}
              disabled={!canGive || purchaseMutation.isPending}
              leftIcon={<GiftIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {total === null
                ? t('giftSubscription.buyNoTotal')
                : t('giftSubscription.buy', { total: formatCurrency(total) })}
            </Button>
          </div>
        )}
      </Card>

      <section className="mt-8" aria-labelledby="gift-landing-purchases-heading">
        <h2 id="gift-landing-purchases-heading" className="text-sm font-semibold text-gray-900">
          {t('giftSubscription.purchasesTitle')}
        </h2>
        {returnedFromPurchase && (
          <Alert variant="info" className="mt-2">
            <p>{t('giftSubscription.purchaseReturned')}</p>
          </Alert>
        )}
        {purchasesQuery.isError ? (
          <p className="mt-2 text-sm text-gray-600">{t('giftSubscription.purchasesUnavailable')}</p>
        ) : purchasesQuery.isSuccess && purchasesQuery.data.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600">{t('giftSubscription.purchasesEmpty')}</p>
        ) : purchasesQuery.isSuccess ? (
          <ul className="mt-2 space-y-3" data-testid="gift-landing-purchases">
            {purchasesQuery.data.map((purchase) => (
              <li key={purchase.stripeSessionId} className="rounded-md border border-gray-200 p-3">
                <p className="text-sm text-gray-900">
                  {t('giftSubscription.purchaseLine', {
                    months: purchase.months,
                    plan: planName(plans, purchase.planId),
                    date: formatDate(purchase.purchasedAt),
                  })}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase text-gray-600">
                    {t('giftSubscription.codeLabel')}
                  </span>
                  <code className="font-mono text-sm tracking-wider">{purchase.code}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void copy(purchase)}
                  >
                    {copied === purchase.stripeSessionId
                      ? t('giftSubscription.codeCopied')
                      : t('giftSubscription.copyCode')}
                  </Button>
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {purchase.status === 'redeemed' && purchase.redeemedAt
                    ? t('giftSubscription.status.redeemed', {
                        date: formatDate(purchase.redeemedAt),
                      })
                    : purchase.status === 'redeemed'
                      ? t('giftSubscription.status.redeemedNoDate')
                      : purchase.status === 'expired'
                        ? t('giftSubscription.status.expired', {
                            date: formatDate(purchase.redeemBy),
                          })
                        : purchase.status === 'unredeemed'
                          ? t('giftSubscription.status.unredeemed', {
                              date: formatDate(purchase.redeemBy),
                            })
                          : t('giftSubscription.status.unknown')}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
