import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert } from '@/components/Alert';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { isNativeApp } from '@/lib/platform';
import type { SubscriptionState } from '@/services/billingService';
import { isPaymentFailing, paymentFailedBodyKey } from './paymentFailing';

/**
 * The app-wide "your payment failed" banner (#593).
 *
 * Settings → Plan status has said this since #767, but only to someone who
 * opens that page. A household admin whose card is declined otherwise finds
 * out from a 402 the next time they add a plant — the caps have already
 * dropped (`getEntitledPlan` entitles `active`/`trialing` only, no grace
 * period) and nothing on the screen they are on says why. This puts the same
 * three facts on every screen of the frame: the payment failed, what changed,
 * and where to fix it.
 *
 * Holds no query of its own: `Layout` passes the subscription it already
 * reads, on the same key every plan-aware card uses. Hides the moment that
 * read reports a paid status again, with no dismiss state to go stale.
 *
 * The action is always an in-app link to Settings → Plan status, never a
 * purchase link: inside the native shells store rules forbid pointing at an
 * outside payment mechanism, and that page already carries the one sentence
 * the shells are allowed (#767). An admin on the web is told the card can be
 * updated there; everyone else is told where to read the details.
 */
export function PaymentFailedBanner({
  subscription,
}: {
  subscription: SubscriptionState | null | undefined;
}) {
  const { t } = useTranslation();
  const isAdmin = useIsHouseholdAdmin();
  if (!isPaymentFailing(subscription)) return null;

  const native = isNativeApp();
  const canUpdateCard = isAdmin && !native;

  return (
    <Alert variant="warning" title={t('settings.billing.paymentFailedTitle')} className="mb-6">
      <div className="space-y-2 text-sm" data-testid="payment-failed-banner">
        <p>{t(paymentFailedBodyKey(subscription))}</p>
        {!isAdmin && !native && <p>{t('settings.billing.adminOnlyBilling')}</p>}
        <p>
          <Link to="/settings/billing" className="font-medium underline">
            {t(
              canUpdateCard
                ? 'settings.billing.paymentFailedBanner.actionAdmin'
                : 'settings.billing.paymentFailedBanner.actionView'
            )}
          </Link>
        </p>
      </div>
    </Alert>
  );
}
