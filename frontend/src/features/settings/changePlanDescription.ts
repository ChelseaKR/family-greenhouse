import { formatDate } from '@/i18n/format';
import type { SubscriptionState } from '@/services/billingService';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The sentence above the plan grid in Settings → Billing: what a new
 * subscription checkout gives before its first charge.
 *
 * Free trials do not stack (owner decision, 2026-10-23). A household on its
 * no-card Garden trial that checks out is first charged when that trial ends,
 * not 14 days later, and the server publishes that date as
 * `checkoutTrialEndsAt` (the same `checkoutTrialFor` rule the checkout
 * applies). This names the date when there is one. A household whose no-card
 * trial is still running but too close to its end for the date to be kept
 * (`trialAvailable: false`) is told it is charged at once. Every other case is
 * the caller's three-state `fallbackKey` (`resolveTrialOffer`).
 */
export function changePlanDescription(
  t: Translate,
  subscription: SubscriptionState | null | undefined,
  fallbackKey: string
): string {
  const firstCharge =
    subscription?.trialAvailable === true
      ? formatDate(subscription.checkoutTrialEndsAt, { month: 'long' })
      : '';
  if (firstCharge) {
    return t('settings.billing.changePlanDescriptionTrialUntil', { date: firstCharge });
  }
  if (subscription?.trialAvailable === false && subscription.noCardTrial?.state === 'active') {
    return t('settings.billing.changePlanDescriptionTrialEndingSoon', {
      date: formatDate(subscription.noCardTrial.endsAt, { month: 'long' }),
    });
  }
  return t(fallbackKey);
}
