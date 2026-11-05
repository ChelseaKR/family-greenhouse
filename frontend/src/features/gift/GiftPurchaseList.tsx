import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';
import { formatDate } from '@/i18n/format';
import type { GiftPurchase, Plan, PlanId } from '@/services/billingService';
import { giftRedeemLink } from './giftLink';

type GiftablePlanId = Exclude<PlanId, 'seedling'>;

/** The tier's catalog name; the id itself when the catalog has not named it. */
function planName(plans: Plan[] | undefined, id: GiftablePlanId): string {
  return plans?.find((p) => p.id === id)?.name ?? id;
}

/**
 * The gifts this account bought, each with its code, a "Copy code" button and
 * a "Copy gift message" button (owner decision D1: no email from us carries
 * the code, so the buyer passes it on themselves). The message names the
 * months and the plan and carries the `/redeem#code` link; it is copied, never
 * sent, so no recipient address is collected.
 *
 * Shared by the public /gift page and Settings → Billing.
 */
export function GiftPurchaseList({
  purchases,
  plans,
  testId = 'gift-purchases',
}: {
  purchases: GiftPurchase[];
  plans: Plan[] | undefined;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<{ id: string; what: 'code' | 'message' } | null>(null);

  const copy = async (purchase: GiftPurchase, what: 'code' | 'message') => {
    const text =
      what === 'code'
        ? purchase.code
        : t('giftSubscription.giftMessage', {
            count: purchase.months,
            plan: planName(plans, purchase.planId),
            link: giftRedeemLink(purchase.code),
          });
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ id: purchase.stripeSessionId, what });
    } catch {
      // The code is on screen either way; a failed copy changes nothing.
      setCopied(null);
    }
  };

  return (
    <ul className="mt-2 space-y-3" data-testid={testId}>
      {purchases.map((purchase) => {
        const usable = purchase.status === 'unredeemed';
        const isCopied = (what: 'code' | 'message') =>
          copied?.id === purchase.stripeSessionId && copied.what === what;
        return (
          <li key={purchase.stripeSessionId} className="rounded-md border border-gray-200 p-3">
            <p className="text-sm text-gray-900">
              {t('giftSubscription.purchaseLine', {
                count: purchase.months,
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
                onClick={() => void copy(purchase, 'code')}
              >
                {isCopied('code')
                  ? t('giftSubscription.codeCopied')
                  : t('giftSubscription.copyCode')}
              </Button>
              {usable && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void copy(purchase, 'message')}
                  data-testid="gift-copy-message"
                >
                  {isCopied('message')
                    ? t('giftSubscription.messageCopied')
                    : t('giftSubscription.copyMessage')}
                </Button>
              )}
            </p>
            <p className="mt-1 text-xs text-gray-600" data-testid="gift-purchase-status">
              {purchase.status === 'redeemed' && purchase.redeemedAt
                ? t('giftSubscription.status.redeemed', { date: formatDate(purchase.redeemedAt) })
                : purchase.status === 'redeemed'
                  ? t('giftSubscription.status.redeemedNoDate')
                  : purchase.status === 'voided'
                    ? t('giftSubscription.status.voided')
                    : purchase.status === 'unredeemed'
                      ? t('giftSubscription.status.unredeemed')
                      : t('giftSubscription.status.unknown')}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
