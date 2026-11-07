import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { AskToUpgrade } from '@/components/LockedFeature';
import { Button } from '@/components/Button';
import { buttonStyles } from '@/components/buttonStyles';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { formatCurrency } from '@/i18n/format';
import { isNativeApp } from '@/lib/platform';
import { billingService, effectivePlanId } from '@/services/billingService';

/**
 * Why the prompt is showing:
 *
 *  - `entry`  the household opened the sitter-link section from the
 *             dashboard's "Going away soon?" card: the moment of intent.
 *  - `longer` the length typed is past the free plan's longest link.
 *  - `second` the free plan's one live link is already in use.
 */
export type GoingAwayReason = 'entry' | 'longer' | 'second';

interface GoingAwayOfferProps {
  householdId: string;
  reason: GoingAwayReason;
  /**
   * Shown for `longer`: sets the form back to the free plan's longest link,
   * so the free path is one tap away from the prompt that interrupted it.
   */
  onUseFreeLength?: () => void;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * "Going away?": what Garden adds for a trip, said at the moment a free
 * household needs it (2026-10-23).
 *
 * ## When it renders
 *
 * Only for a household whose CURRENT tier, read from the live catalog, has
 * `features.awayKit === false`. A pending or failed read renders nothing,
 * because "your plan doesn't include this" is a claim and an unread is not
 * evidence for it (ADR 0010). A household on the no-card trial is on Garden's
 * features already and never sees it.
 *
 * ## What it says
 *
 * Every figure is the catalog's: the free plan's longest link, Garden's
 * longest link and how many may be live at once, and Garden's monthly price.
 * A sentence whose figure did not arrive is left out, not guessed. The
 * feature lines are the Away Kit as the help pages describe it: the printable
 * brief, photos from the sitter and the return recap.
 *
 * It also says, every time, that the free link is still there. Nothing here
 * blocks creating it, and there is no countdown, no "offer ends" and no
 * pre-checked anything.
 *
 * ## The button
 *
 * Web, admin, payments on: a link to Settings → Billing, where the existing
 * checkout runs with its double-charge guards and trial terms. This prompt
 * does not start a Stripe session itself. A member gets the existing one-tap
 * "ask an admin" (`AskToUpgrade`). Inside the apps there is no price and no
 * purchase button (Guideline 3.1.1), the same rule `LockedFeature` follows.
 */
export function GoingAwayOffer({ householdId, reason, onUseFreeLength }: GoingAwayOfferProps) {
  const { t } = useTranslation();
  const isAdmin = useIsHouseholdAdmin();
  const titleId = useId();
  const native = isNativeApp();

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    staleTime: 60_000,
  });

  const plans = plansQuery.data?.plans;
  const subscription = subscriptionQuery.data;
  const currentId = subscription ? effectivePlanId(subscription) : null;
  const current = currentId ? plans?.find((plan) => plan.id === currentId) : undefined;
  const garden = plans?.find((plan) => plan.id === 'garden');

  // The gate: a settled read that says this tier lacks the Away Kit, and a
  // Garden in the catalog that has it. Anything else is not a free household
  // we can make a true offer to.
  if (current?.features?.awayKit !== false || garden?.features?.awayKit !== true) return null;

  const freeDays = current.limits?.sitterLinkMaxDays;
  const freeActive = current.limits?.sitterLinksActive;
  const gardenDays = garden.limits?.sitterLinkMaxDays;
  const gardenActive = garden.limits?.sitterLinksActive;
  const monthly = garden.monthlyPrice;
  const price = !native && isCount(monthly) && monthly > 0 ? formatCurrency(monthly) : null;
  const paymentsOn = plansQuery.data?.paymentsAvailable === true;
  const trialEnded = subscription?.noCardTrial?.state === 'ended';

  const title =
    reason === 'longer' && isCount(freeDays)
      ? t('household.goingAway.titleLonger', { count: freeDays })
      : reason === 'second'
        ? t('household.goingAway.titleSecond')
        : t('household.goingAway.titleEntry');

  const lines = [
    isCount(gardenDays) && isCount(gardenActive)
      ? t('household.goingAway.lineLinks', { days: gardenDays, count: gardenActive })
      : null,
    t('household.goingAway.lineBrief'),
    t('household.goingAway.linePhotos'),
    t('household.goingAway.lineRecap'),
  ].filter((line): line is string => line !== null);

  const buyLabel = price
    ? trialEnded
      ? t('settings.billing.noCardTrial.getGardenBack', { price })
      : t('household.goingAway.upgrade', { price })
    : null;

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-lg border border-primary-200/70 bg-primary-50/70 p-4"
      data-testid="going-away-offer"
      data-reason={reason}
    >
      <div className="flex items-start gap-3">
        <span
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 ring-1 ring-primary-200/60 sm:inline-flex"
          aria-hidden="true"
        >
          <PaperAirplaneIcon className="h-5 w-5 text-primary-800" />
        </span>
        <div className="min-w-0 flex-1 space-y-3 text-sm text-gray-800">
          <h3 id={titleId} className="font-serif text-lg text-ink">
            {title}
          </h3>
          {isCount(freeDays) && isCount(freeActive) && (
            <p>{t('household.goingAway.freeNow', { count: freeActive, days: freeDays })}</p>
          )}
          <div>
            <p className="font-medium text-primary-900">
              {price
                ? t('household.goingAway.gardenAddsPrice', { price })
                : t('household.goingAway.gardenAdds')}
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {native ? (
              <p className="text-gray-600">{t('settings.billing.nativeUnavailable')}</p>
            ) : isAdmin ? (
              buyLabel &&
              paymentsOn && (
                <Link
                  to="/settings/billing"
                  // The price makes this label long; on a phone it wraps
                  // rather than clipping (the shared style never wraps).
                  className={buttonStyles({ className: 'text-center whitespace-normal!' })}
                >
                  {buyLabel}
                </Link>
              )
            ) : (
              <AskToUpgrade feature="away_kit" />
            )}
            {reason === 'longer' && onUseFreeLength && isCount(freeDays) && (
              <Button
                type="button"
                variant="secondary"
                onClick={onUseFreeLength}
                className="text-center whitespace-normal!"
              >
                {t('household.goingAway.useFree', { count: freeDays })}
              </Button>
            )}
          </div>

          {isCount(freeDays) && (
            <p className="text-xs text-gray-600">
              {reason === 'second'
                ? t('household.goingAway.keepFreeSecond')
                : t('household.goingAway.keepFree', { count: freeDays })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
