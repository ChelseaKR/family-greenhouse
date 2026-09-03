import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SparklesIcon } from '@heroicons/react/24/outline';
import { billingService, type IdentifyCreditBalance } from '@/services/billingService';
import { formatCurrency, formatDate } from '@/i18n/format';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';

/**
 * Map the API's refusals onto something a household can act on. None is
 * recoverable by retrying the same request unchanged. The 400 is the
 * fail-closed "not for sale in this environment" answer — no price is
 * configured — and must read as exactly that, not as a broken provider.
 */
function purchaseErrorKey(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: { details?: unknown } } })
    ?.response;
  const code = (response?.data?.details as { code?: unknown } | undefined)?.code;
  if (response?.status === 400 && code === 'TOP_UP_NOT_CONFIGURED') {
    return 'identifyTopUp.errorNotConfigured';
  }
  if (response?.status === 503) return 'identifyTopUp.errorPaymentsPaused';
  if (response?.status === 403) return 'identifyTopUp.errorNotAdmin';
  return 'identifyTopUp.errorProviderUnreachable';
}

export interface IdentifyTopUpCardProps {
  /** Pack size, from the catalog (or the 402's `topUp`). */
  credits: number;
  /** Pack price in dollars. `null` = withheld; no purchase button is shown,
   *  because a button with no price is a promise the API will not keep. */
  priceUsd: number | null;
  /** How long a pack lasts; only shown when known. */
  validityDays?: number;
  /** False hides the purchase controls (pack not for sale here) but keeps
   *  the balance visible for a household that already holds credits. */
  available: boolean;
  /**
   * The household's credit balance. Three states, never two: a balance
   * (a genuine 0 included), `null` when the server could not read it, and
   * `undefined` when this surface has no balance to show at all.
   */
  balance?: IdentifyCreditBalance | null;
  /** `exhausted` leads with "this month's identifications are used up";
   *  `billing` leads with the offer. */
  variant: 'exhausted' | 'billing';
}

/**
 * The identification top-up pack (ADR 0019): a one-time purchase of extra
 * identifications, drawn on only once the plan's monthly allowance is
 * spent. Rendered on the identify budget-exhausted state and on the billing
 * page. Purchase is admin-only — the same rule as every other purchase —
 * and members are told so rather than shown nothing.
 */
export function IdentifyTopUpCard({
  credits,
  priceUsd,
  validityDays,
  available,
  balance,
  variant,
}: IdentifyTopUpCardProps) {
  const { t } = useTranslation();
  const isAdmin = useIsHouseholdAdmin();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      billingService.createTopUpCheckout({
        // Per click, not per render: this is Stripe's idempotency key, so a
        // retried request must reuse it and a genuine second click must not.
        checkoutAttemptId: crypto.randomUUID(),
      }),
    onMutate: () => setErrorKey(null),
    // Hand off to Stripe by full-page navigation; credits come back through
    // the webhook, never through this response.
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error) => setErrorKey(purchaseErrorKey(error)),
  });

  const price = priceUsd === null ? null : formatCurrency(priceUsd);
  const canOffer = available && price !== null;

  return (
    <div data-testid="identify-top-up-card">
      <Card variant="paper">
        <CardHeader
          title={
            variant === 'exhausted' ? t('identifyTopUp.exhaustedTitle') : t('identifyTopUp.title')
          }
          description={
            variant === 'exhausted' ? t('identifyTopUp.exhaustedBody') : t('identifyTopUp.body')
          }
        />
        {errorKey && (
          <Alert variant="error" title={t('identifyTopUp.errorTitle')} className="mb-4">
            <p>{t(errorKey)}</p>
          </Alert>
        )}
        {balance !== undefined && (
          <p className="text-sm text-gray-700" data-testid="identify-credit-balance">
            {balance === null
              ? t('identifyTopUp.balanceUnavailable')
              : balance.remaining > 0 && balance.expiresAt
                ? t('identifyTopUp.balanceExpires', {
                    n: balance.remaining,
                    date: formatDate(balance.expiresAt),
                  })
                : balance.remaining > 0
                  ? t('identifyTopUp.balance', { n: balance.remaining })
                  : t('identifyTopUp.balanceNone')}
          </p>
        )}
        {canOffer && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-gray-900">
              {t('identifyTopUp.offer', { credits, price })}
            </p>
            <p className="text-xs text-gray-600">
              {validityDays
                ? t('identifyTopUp.terms', { days: validityDays })
                : t('identifyTopUp.termsNoDays')}
            </p>
            {isAdmin ? (
              <Button
                type="button"
                onClick={() => mutation.mutate()}
                isLoading={mutation.isPending}
                disabled={mutation.isPending}
                leftIcon={<SparklesIcon className="h-4 w-4" aria-hidden="true" />}
              >
                {t('identifyTopUp.buy', { credits, price })}
              </Button>
            ) : (
              <p className="text-sm text-gray-600">{t('identifyTopUp.adminOnly')}</p>
            )}
          </div>
        )}
        {!canOffer && <p className="mt-4 text-sm text-gray-600">{t('identifyTopUp.notForSale')}</p>}
      </Card>
    </div>
  );
}
