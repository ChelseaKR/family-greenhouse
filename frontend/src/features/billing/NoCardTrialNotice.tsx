import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert } from '@/components/Alert';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { formatDate } from '@/i18n/format';
import {
  billingService,
  type Plan,
  type PlanLimits,
  type SubscriptionState,
} from '@/services/billingService';
import { noCardTrialNoticeKind, type NoCardTrialPlacement } from './noCardTrialNoticeKind';

/**
 * The in-app notices for the no-card Garden trial (ADR 0027).
 *
 * Three moments, and nothing is sent anywhere else — no email, no push:
 *
 *   - `started`    while the trial runs: what it includes, that no card is
 *                  needed, and the date it ends.
 *   - `endingSoon` in its last NO_CARD_TRIAL_ENDING_SOON_DAYS: the date, and
 *                  exactly what changes when it ends.
 *   - `ended`      after it: what changed. The dashboard stops repeating it
 *                  after NO_CARD_TRIAL_ENDED_DASHBOARD_DAYS; Settings → Billing
 *                  keeps saying it.
 *
 * Whether the trial is running is the SERVER's answer (`noCardTrial.state`).
 * The client clock only chooses between the two sentences for a running trial,
 * so a wrong clock can shift the warning by a day, never claim a trial that has
 * ended is still on.
 *
 * Every figure comes from the published plan catalog, never from this file, so
 * the copy cannot drift from the caps the API enforces. A line that needs a
 * figure the catalog has not delivered is left out rather than guessed.
 */

function limitsOf(plans: Plan[] | undefined, id: Plan['id']): PlanLimits | undefined {
  return plans?.find((plan) => plan.id === id)?.limits;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The dashboard's notice: reads the subscription and the catalog itself, on the
 * same query keys every other plan-aware card uses.
 */
export function NoCardTrialNotice({ placement }: { placement: NoCardTrialPlacement }) {
  const householdId = useActiveHouseholdId();
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: Boolean(householdId),
    staleTime: 60_000,
  });
  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  return (
    <NoCardTrialNoticeView
      placement={placement}
      subscription={subscriptionQuery.data}
      plans={plansQuery.data?.plans}
    />
  );
}

/**
 * The notice itself, holding no query of its own. Settings → Billing renders
 * this with the reads it already has instead of mounting a second observer on
 * them: the page's failed-read tests showed a second observer there re-fetching
 * a failed subscription read on every mount and the page never settling.
 */
export function NoCardTrialNoticeView({
  placement,
  subscription,
  plans,
}: {
  placement: NoCardTrialPlacement;
  subscription: SubscriptionState | null | undefined;
  plans: Plan[] | undefined;
}) {
  const { t } = useTranslation();
  const kind = noCardTrialNoticeKind(subscription, placement);
  const trial = subscription?.noCardTrial;
  if (!kind || !trial) return null;

  const date = formatDate(trial.endsAt, { month: 'long' });
  const seedling = limitsOf(plans, 'seedling');
  const garden = limitsOf(plans, 'garden');
  const key = (name: string) => `settings.billing.noCardTrial.${name}`;

  const includes =
    seedling &&
    garden &&
    isCount(seedling.members) &&
    isCount(garden.plants) &&
    isCount(garden.sitterLinkMaxDays)
      ? t(key('includes'), {
          members: seedling.members,
          plants: garden.plants,
          sitterDays: garden.sitterLinkMaxDays,
        })
      : null;

  const changes = seedling
    ? [
        isCount(seedling.plants) ? t(key('changePlants'), { plants: seedling.plants }) : null,
        isCount(seedling.members) ? t(key('changeMembers'), { members: seedling.members }) : null,
        t(key('changeTags')),
        isCount(seedling.sitterLinkMaxDays)
          ? t(key('changeSitter'), { sitterDays: seedling.sitterLinkMaxDays })
          : null,
        t(key('changeToolkit')),
        isCount(seedling.analyticsHistoryDays)
          ? t(key('changeAnalytics'), { days: seedling.analyticsHistoryDays })
          : null,
      ].filter((line): line is string => line !== null)
    : [];

  return (
    <Alert
      variant={kind === 'endingSoon' ? 'warning' : 'info'}
      title={t(key(`${kind}Title`), { date })}
    >
      <div className="space-y-2 text-sm" data-testid="no-card-trial-notice" data-kind={kind}>
        {kind === 'ended' ? (
          <p>{t(key('endedNow'))}</p>
        ) : (
          <>
            <p>{t(key('noCard'))}</p>
            {kind === 'started' && includes && <p>{includes}</p>}
            {kind === 'started' && <p>{t(key('metered'))}</p>}
            <p>{t(key('after'), { date })}</p>
          </>
        )}
        {kind !== 'started' && changes.length > 0 && (
          <>
            <p className="font-medium">
              {t(key(kind === 'ended' ? 'changedHeading' : 'changesHeading'))}
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {placement === 'billing' && kind !== 'ended' && <p>{t(key('subscribeReplaces'))}</p>}
        {placement === 'dashboard' && (
          <p>
            <Link to="/settings/billing" className="font-medium underline">
              {t(key('billingLink'))}
            </Link>
          </p>
        )}
      </div>
    </Alert>
  );
}
