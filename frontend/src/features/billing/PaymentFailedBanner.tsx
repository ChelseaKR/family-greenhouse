import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert } from '@/components/Alert';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { isNativeApp } from '@/lib/platform';
import { billingService, type SubscriptionState } from '@/services/billingService';
import { paymentFailedCopy, paymentFailureStage } from './paymentFailing';

/**
 * The app-wide "your payment failed" banner (#593).
 *
 * Settings → Plan status has said this since #767, but only to someone who
 * opens that page. This puts the same facts on every screen of the frame: the
 * payment failed, what it means right now, and where to fix it.
 *
 * What it means right now depends on the stage (`paymentFailing.ts`). While
 * Stripe is still retrying (`past_due`) the household keeps its plan, so the
 * banner says exactly that and asks for the card before the retries run out.
 * Once Stripe has given up the caps have dropped, and the banner says so.
 *
 * Reads the subscription `Layout` already holds. The plan catalog is read
 * only while a payment is failing, on the shared `['plans']` key, to name the
 * plan being kept; until it answers, the sentence names no plan rather than a
 * guessed one. Hides the moment the subscription read reports a paid status
 * again, with no dismiss state to go stale.
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
  const stage = paymentFailureStage(subscription);
  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: billingService.listPlans,
    enabled: stage === 'retrying',
  });
  const planName =
    plansQuery.data?.plans.find((plan) => plan.id === subscription?.planId)?.name ?? null;
  const copy = paymentFailedCopy(subscription, planName);
  if (!copy) return null;

  const native = isNativeApp();
  const canUpdateCard = isAdmin && !native;

  return (
    <Alert variant="warning" title={t(copy.titleKey)} className="mb-6">
      <div className="space-y-2 text-sm" data-testid="payment-failed-banner" data-stage={stage}>
        <p>{t(copy.bodyKey, copy.values)}</p>
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
