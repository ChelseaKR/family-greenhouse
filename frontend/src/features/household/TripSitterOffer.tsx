import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LockedFeature } from '@/components/LockedFeature';
import { billingService } from '@/services/billingService';
import { tripLengthDays } from './localDates';

/**
 * The sitter-link offer, at the moment a trip is declared (ADR 0015, #480).
 *
 * ## Why it is here and not in the sitter-link form
 *
 * The Away Kit's upgrade prompt used to fire in exactly one place:
 * `SitterLinksCard`, when someone typed a window longer than seven days. Two
 * things are wrong with that. It is the moment of FAILURE rather than the
 * moment of intent, and it is only reachable by someone who already knows
 * sitter links exist — the form even shows the seven-day maximum while you
 * type, so most people never push against the wall at all.
 *
 * The vacation window is where a person says "I am away June 3rd to 24th":
 * dated, specific, and typed by someone who is thinking about the trip. It
 * mentioned sitter links nowhere. So this component says two true things
 * there, in this order:
 *
 *   1. always — that a sitter link exists and what it does, with a link to
 *      the form on this page. This half is not an upsell at all: it is a free
 *      feature that the moment of intent never pointed at.
 *   2. only when the trip is longer than the plan's own cap — how long one
 *      link on this plan covers, and (when a higher tier lifts it) the
 *      standard one-tap ask.
 *
 * ## What it will not claim
 *
 * The cap sentence is rendered ONLY from a `sitterLinkMaxDays` we actually
 * read out of the live catalog. `undefined` is "we could not determine it"
 * (a failed read, or an older backend with no `limits` map) and `null` is
 * UNLIMITED (ADR 0014) — neither is a cap a trip can exceed, and neither may
 * be rendered as seven days. Likewise the locked card appears only on
 * `features.awayKit === false`: "your plan doesn't include the Away Kit" is a
 * claim, and a read that did not land does not get to make it (ADR 0010).
 *
 * That gate also keeps the ask honest at the top of the catalog. A Garden
 * household typing a 120-day trip is over its own 90-day cap and is told so —
 * but it already HAS the Away Kit, so it is not offered an upgrade that would
 * change nothing.
 */
interface TripSitterOfferProps {
  householdId: string;
  /** The dates exactly as typed in the vacation form; may be empty. */
  startDate: string;
  endDate: string;
}

export function TripSitterOffer({ householdId, startDate, endDate }: TripSitterOfferProps) {
  const { t } = useTranslation();

  const tripDays = tripLengthDays(startDate, endDate);

  // Both queries are keyed the same way `LockedFeature` and `SitterLinksCard`
  // key theirs, so an open form costs no extra request — and neither runs at
  // all until there is a whole trip to say something about, so opening the
  // form and closing it again spends nothing.
  const plansQuery = useQuery({
    queryKey: ['plans'],
    queryFn: billingService.listPlans,
    enabled: tripDays !== null,
  });
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    staleTime: 60_000,
    enabled: tripDays !== null,
  });

  // Hooks are unconditional; the bail-out comes after them.
  if (tripDays === null) return null;

  const plan =
    plansQuery.data && subscriptionQuery.data
      ? plansQuery.data.plans.find((p) => p.id === subscriptionQuery.data.planId)
      : undefined;
  const capDays = plan?.limits?.sitterLinkMaxDays;
  const overCap = typeof capDays === 'number' && tripDays > capDays;
  const hasAwayKit: boolean | undefined = plan?.features?.awayKit;

  const trip = t('household.vacation.sitter.days', { count: tripDays });

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-gray-600">
        {overCap
          ? t('household.vacation.sitter.capLine', {
              trip,
              cap: t('household.vacation.sitter.days', { count: capDays }),
            })
          : t('household.vacation.sitter.tripHint', { trip })}{' '}
        {/* The sitter-link form is the `#sitter-links` section of this same
            page (HouseholdPage), which is the only place this component
            renders. A same-page fragment, so no route change mid-form. */}
        <a href="#sitter-links" className="font-medium text-primary-700 hover:underline">
          {t('household.vacation.sitter.setUp')}
        </a>
      </p>
      {overCap && hasAwayKit === false && (
        <LockedFeature feature="away_kit">
          {t('household.vacation.sitter.lockedBody')}
        </LockedFeature>
      )}
    </div>
  );
}
