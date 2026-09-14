import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GiftIcon } from '@heroicons/react/24/outline';
import {
  billingService,
  type GiftPurchase,
  type GiftState,
  type GiftSubscriptionOffer,
  type Plan,
  type PlanId,
} from '@/services/billingService';
import { formatCurrency, formatDate } from '@/i18n/format';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';

type GiftablePlanId = Exclude<PlanId, 'seedling'>;

/** How long to keep re-reading the purchase list after Stripe sends the buyer back. */
const PURCHASE_POLL_MS = 60_000;

const REDEEM_ERROR_CODES = new Set([
  'GIFT_CODE_INVALID',
  'GIFT_CODE_EXPIRED',
  'GIFT_CODE_REDEEMED',
  'GIFT_HOUSEHOLD_SUBSCRIBED',
  'GIFT_ALREADY_ACTIVE',
  'GIFT_ADDS_NOTHING',
  'GIFT_REDEEM_CONFLICT',
]);

interface ApiErrorShape {
  response?: {
    status?: number;
    data?: { details?: { code?: unknown; endsAt?: unknown; redeemBy?: unknown } };
  };
}

/**
 * Map a redemption refusal onto the sentence for it. The server's
 * `details.code` is the contract; a status without one is either the rate
 * limit or something we cannot name, and gets the honest generic line.
 */
function redeemError(error: unknown): { key: string; date?: string } {
  const response = (error as ApiErrorShape)?.response;
  const code = response?.data?.details?.code;
  if (typeof code === 'string' && REDEEM_ERROR_CODES.has(code)) {
    const raw = response?.data?.details?.endsAt ?? response?.data?.details?.redeemBy;
    return {
      key: `giftSubscription.errors.${code}`,
      date: typeof raw === 'string' ? raw : undefined,
    };
  }
  if (response?.status === 429) return { key: 'giftSubscription.errors.rateLimited' };
  if (response?.status === 403) return { key: 'giftSubscription.redeemAdminOnly' };
  return { key: 'giftSubscription.errors.generic' };
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

export interface GiftSubscriptionCardProps {
  /** The offer from GET /billing/plans. Absent on older backends: render nothing. */
  offer: GiftSubscriptionOffer;
  /** The catalog, for tier names and monthly prices. */
  plans: Plan[] | undefined;
  paymentsAvailable: boolean;
  /** The household's running gift, if any, from GET /billing/me. */
  gift: GiftState | null | undefined;
  /** True when Stripe has just sent the buyer back from a gift checkout. */
  returnedFromPurchase: boolean;
}

/**
 * Gift subscriptions (ADR 0028), on Settings → Billing: give one, redeem one,
 * and see the ones this account bought with their codes.
 *
 * Buying is open to any member — it charges the buyer's own card and changes
 * nothing about their household. Redeeming is admin-only, because it changes
 * the household's plan. A gift the household is on is announced at the top
 * with its end date: nothing is charged to the household and nothing renews.
 */
export function GiftSubscriptionCard({
  offer,
  plans,
  paymentsAvailable,
  gift,
  returnedFromPurchase,
}: GiftSubscriptionCardProps) {
  const { t } = useTranslation();
  const isAdmin = useIsHouseholdAdmin();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();

  const givable = offer.plans.filter((p) => p.available && paymentsAvailable);
  const [planId, setPlanId] = useState<GiftablePlanId>(givable[0]?.planId ?? 'garden');
  const [months, setMonths] = useState(3);
  const [purchaseErrorKeyState, setPurchaseErrorKey] = useState<string | null>(null);
  const selectedPlan = plans?.find((p) => p.id === planId);
  const monthly = selectedPlan?.monthlyPrice;
  const total = typeof monthly === 'number' ? giftTotal(monthly, months) : null;
  const canGive = givable.some((p) => p.planId === planId) && total !== null;

  const purchaseMutation = useMutation({
    mutationFn: () =>
      billingService.createGiftCheckout({
        planId,
        months,
        // Per click, not per render: this is Stripe's idempotency key.
        checkoutAttemptId: crypto.randomUUID(),
      }),
    onMutate: () => setPurchaseErrorKey(null),
    // Hand off to Stripe by full-page navigation; the code comes back through
    // the webhook and the purchase list, never through this response.
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error) => setPurchaseErrorKey(purchaseErrorKey(error)),
  });

  // The buyer's own gifts. Polled briefly after a checkout return, because
  // the webhook that creates the code may land a moment after the redirect.
  const [pollUntil] = useState(() => (returnedFromPurchase ? Date.now() + PURCHASE_POLL_MS : 0));
  const purchasesQuery = useQuery({
    queryKey: ['giftPurchases'],
    queryFn: billingService.listGiftPurchases,
    staleTime: 0,
    refetchInterval: () => (Date.now() < pollUntil ? 3000 : false),
  });

  const [code, setCode] = useState('');
  const [redeemErrorState, setRedeemError] = useState<{ key: string; date?: string } | null>(null);
  const [redeemed, setRedeemed] = useState<{ planId: GiftablePlanId; endsAt: string } | null>(null);
  const redeemMutation = useMutation({
    mutationFn: () => billingService.redeemGiftCode({ code }),
    onMutate: () => {
      setRedeemError(null);
      setRedeemed(null);
    },
    onSuccess: (result) => {
      setRedeemed(result);
      setCode('');
      // Entitlement changed behind every plan-aware card: re-read it.
      void queryClient.invalidateQueries({ queryKey: ['subscription', householdId] });
    },
    onError: (error) => setRedeemError(redeemError(error)),
  });

  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (purchase: GiftPurchase) => {
    try {
      await navigator.clipboard.writeText(purchase.code);
      setCopied(purchase.stripeSessionId);
    } catch {
      // The code is on screen either way; a failed copy changes nothing.
      setCopied(null);
    }
  };

  return (
    <div data-testid="gift-subscription-card">
      <Card variant="paper">
        <CardHeader title={t('giftSubscription.title')} description={t('giftSubscription.body')} />

        {gift?.state === 'active' && (
          <div data-testid="gift-active-notice">
            <Alert variant="info" className="mb-4">
              <p className="font-semibold">
                {t('giftSubscription.activeTitle', {
                  plan: planName(plans, gift.planId),
                  date: formatDate(gift.endsAt),
                })}
              </p>
              <p className="mt-1 text-sm">
                {t('giftSubscription.activeBody', { date: formatDate(gift.endsAt) })}
              </p>
            </Alert>
          </div>
        )}

        {/* Give */}
        <section className="mt-2" aria-labelledby="gift-give-heading">
          <h3 id="gift-give-heading" className="text-sm font-semibold text-gray-900">
            {t('giftSubscription.giveTitle')}
          </h3>
          {purchaseErrorKeyState && (
            <Alert
              variant="error"
              title={t('giftSubscription.purchaseErrorTitle')}
              className="mt-2 mb-2"
            >
              <p>{t(purchaseErrorKeyState)}</p>
            </Alert>
          )}
          {givable.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600">{t('giftSubscription.notForSale')}</p>
          ) : (
            <div className="mt-2 space-y-3">
              <div className="flex flex-wrap gap-3">
                <div>
                  <label htmlFor="gift-plan" className="label">
                    {t('giftSubscription.planLabel')}
                  </label>
                  <select
                    id="gift-plan"
                    className="input"
                    value={planId}
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
                  <label htmlFor="gift-months" className="label">
                    {t('giftSubscription.monthsLabel')}
                  </label>
                  <select
                    id="gift-months"
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
                <p className="text-sm font-medium text-gray-900" data-testid="gift-total">
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
        </section>

        {/* Gifts you've bought */}
        <section className="mt-6" aria-labelledby="gift-purchases-heading">
          <h3 id="gift-purchases-heading" className="text-sm font-semibold text-gray-900">
            {t('giftSubscription.purchasesTitle')}
          </h3>
          {returnedFromPurchase && (
            <Alert variant="info" className="mt-2">
              <p>{t('giftSubscription.purchaseReturned')}</p>
            </Alert>
          )}
          {purchasesQuery.isError ? (
            <p className="mt-2 text-sm text-gray-600" data-testid="gift-purchases-unavailable">
              {t('giftSubscription.purchasesUnavailable')}
            </p>
          ) : purchasesQuery.isSuccess && purchasesQuery.data.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600" data-testid="gift-purchases-empty">
              {t('giftSubscription.purchasesEmpty')}
            </p>
          ) : purchasesQuery.isSuccess ? (
            <ul className="mt-2 space-y-3" data-testid="gift-purchases">
              {purchasesQuery.data.map((purchase) => (
                <li
                  key={purchase.stripeSessionId}
                  className="rounded-md border border-gray-200 p-3"
                >
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
                    <code className="font-mono text-sm tracking-wider" data-testid="gift-code">
                      {purchase.code}
                    </code>
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
                  <p className="mt-1 text-xs text-gray-600" data-testid="gift-purchase-status">
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

        {/* Redeem */}
        <section className="mt-6" aria-labelledby="gift-redeem-heading">
          <h3 id="gift-redeem-heading" className="text-sm font-semibold text-gray-900">
            {t('giftSubscription.redeemTitle')}
          </h3>
          <p className="mt-1 text-sm text-gray-600">{t('giftSubscription.redeemBody')}</p>
          {redeemErrorState && (
            <Alert variant="error" title={t('giftSubscription.errorTitle')} className="mt-2">
              <p>
                {t(redeemErrorState.key, {
                  date: redeemErrorState.date ? formatDate(redeemErrorState.date) : '',
                })}
              </p>
            </Alert>
          )}
          {redeemed && (
            <div data-testid="gift-redeemed">
              <Alert variant="success" className="mt-2">
                <p>
                  {t('giftSubscription.redeemed', {
                    plan: planName(plans, redeemed.planId),
                    date: formatDate(redeemed.endsAt),
                  })}
                </p>
              </Alert>
            </div>
          )}
          {isAdmin ? (
            <form
              className="mt-2 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim() !== '') redeemMutation.mutate();
              }}
            >
              <div className="min-w-[16rem] grow">
                <Input
                  id="gift-code"
                  label={t('giftSubscription.codeInputLabel')}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t('giftSubscription.codePlaceholder')}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </div>
              <Button
                type="submit"
                isLoading={redeemMutation.isPending}
                disabled={code.trim() === '' || redeemMutation.isPending}
              >
                {t('giftSubscription.redeem')}
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-sm text-gray-600">{t('giftSubscription.redeemAdminOnly')}</p>
          )}
        </section>
      </Card>
    </div>
  );
}
