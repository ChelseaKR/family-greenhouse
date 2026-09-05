import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { SparklesIcon } from '@heroicons/react/24/outline';
import {
  billingService,
  evaluatePlanLimits,
  readOutcome,
  resolveCurrentPlan,
  resolvePlanUsage,
  type BillingInterval,
  type Plan,
  type PlanId,
  type PlanLimitEvaluation,
  type PlanUsageDetail,
} from '@/services/billingService';
import { formatDate } from '@/i18n/format';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { useActiveHouseholdName } from '@/hooks/useActiveHouseholdName';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { AskToUpgrade } from '@/components/LockedFeature';
import { PaidPlanGrid } from '@/features/pricing/PaidPlanGrid';
import { SplitTheBill } from '@/features/pricing/SplitTheBill';
import { IdentifyTopUpCard } from '@/features/billing/IdentifyTopUpCard';
import { isNativeApp } from '@/lib/platform';
import { COMMERCIAL_HOLD_ACTIVE, COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';
import clsx from 'clsx';

/** How long to poll for entitlement after returning from Stripe. Long enough
 *  to cover normal webhook delivery, short enough that a user who lingers on
 *  the page is not polled indefinitely. */
const CHECKOUT_POLL_MS = 20_000;

/** Ascending entitlement order, mirroring PLAN_ORDER in backend/src/models/plans.ts.
 *  A lifetime purchase is a floor: tiers at or below it are already owned. */
const PLAN_ORDER: PlanId[] = ['seedling', 'garden', 'greenhouse'];
const planRank = (id: PlanId) => PLAN_ORDER.indexOf(id);

/** Statuses that mean Stripe considers the subscription live, mirroring
 *  LIVE_SUBSCRIPTION_STATUSES in backend/src/services/billing.ts. A household
 *  in one of these must change plans through the portal: the API rejects a
 *  second purchase with 409 precisely to avoid double-billing. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

/** Map the API's failure modes onto something a household can act on. The
 *  server is the authority on all three; none of them are recoverable by
 *  retrying the same request unchanged. */
function purchaseErrorKey(error: unknown): string {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 409) {
    // Two different 409s: already subscribed (fix: use the portal) and already
    // owned outright (fix: nothing, there is nothing left to buy). Telling a
    // lifetime owner to "use Manage subscription to change plans" would send
    // them somewhere that cannot help them.
    const detail = (error as { response?: { data?: { error?: string; message?: string } } })
      ?.response?.data;
    return /permanently/i.test(`${detail?.error ?? ''} ${detail?.message ?? ''}`)
      ? 'settings.billing.errorLifetimeOwned'
      : 'settings.billing.errorAlreadySubscribed';
  }
  if (status === 503) return 'settings.billing.errorPaymentsPaused';
  if (status === 403) return 'settings.billing.errorNotAdmin';
  return 'settings.billing.errorProviderUnreachable';
}

export function BillingSettings() {
  const { t } = useTranslation();

  // Native retains its existing read-only notice. The repository commercial
  // hold now makes the web surface read-only as well.
  const native = isNativeApp();

  const householdId = useActiveHouseholdId();
  const isAdmin = useIsHouseholdAdmin();
  // For the split-the-bill share line; null while unknown, never a blank.
  const householdName = useActiveHouseholdName();
  const [purchaseErrorKeyState, setPurchaseErrorKey] = useState<string | null>(null);
  // Stripe redirects back to ?status=success after a completed checkout.
  const [searchParams] = useSearchParams();
  // Captured once, on the render that first sees the redirect, so the window
  // does not restart on every re-render while polling.
  const [pollUntil] = useState(() =>
    searchParams.get('status') === 'success' ? Date.now() + CHECKOUT_POLL_MS : 0
  );
  // A top-up checkout returns here with `purchase=identify-top-up`; the
  // credits themselves arrive through the webhook, so the balance below may
  // lag the redirect by a moment — say so rather than show an unchanged 0.
  const returnedFromTopUp =
    searchParams.get('status') === 'success' && searchParams.get('purchase') === 'identify-top-up';
  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subQuery = useQuery({
    // Plan state is per-household; the backend resolves the ACTIVE household
    // (X-Household-Id header), so the key must embed it too.
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!householdId,
    // Entitlement is the one piece of state a webhook changes behind the
    // user's back: Stripe tells the server, never this client. The app-wide
    // defaults (5-minute staleTime, refetchOnWindowFocus off) are right for
    // data only this client mutates, but here they mean a household that just
    // paid — or just cancelled — keeps seeing its old plan with no way to
    // learn otherwise. Both are overridden for this query alone.
    staleTime: 0,
    refetchOnWindowFocus: true,
    // Returning from Stripe is a strong signal that entitlement is about to
    // change, but the webhook may land a moment after the redirect does, so a
    // single refetch can easily read the pre-purchase row. Poll briefly, then
    // stop — an unbounded interval would hammer the API for every open tab.
    refetchInterval: () => (Date.now() < pollUntil ? 2000 : false),
  });

  // Both mutations hand off to Stripe by full-page navigation rather than
  // returning to React state: the redirect leaves the SPA entirely, so there
  // is no success path to render here and no cache to invalidate. Entitlement
  // comes back through the webhook, not through this response.
  const checkoutMutation = useMutation({
    mutationFn: (vars: { planId: 'garden' | 'greenhouse'; interval: BillingInterval }) =>
      billingService.createCheckout({
        ...vars,
        // Generated per click, not per render: this is Stripe's idempotency
        // key, so a retried request must reuse it while a genuine second
        // attempt must not.
        checkoutAttemptId: crypto.randomUUID(),
      }),
    onMutate: () => setPurchaseErrorKey(null),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error) => setPurchaseErrorKey(purchaseErrorKey(error)),
  });

  const portalMutation = useMutation({
    mutationFn: () => billingService.createPortalSession(),
    onMutate: () => setPurchaseErrorKey(null),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (error) => setPurchaseErrorKey(purchaseErrorKey(error)),
  });

  if (plansQuery.isLoading || subQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Nothing downstream may read this emptiness as an answer: `planRead`
  // below carries whether the catalog was actually read, and every claim on
  // this card goes through it.
  const plans = plansQuery.data?.plans ?? EMPTY_PLANS;
  // Fail closed if an old or malformed API response omits the status field.
  const paymentsAvailable = plansQuery.data?.paymentsAvailable === true;
  // Which plan the household is on, as a settled three-state read (ADR 0010),
  // the same shape as useSpaces (#534) and CoverageCard (#417).
  //
  // This used to be three independent fallbacks that all collapsed to the free
  // tier — `plans ?? []`, `planId ?? 'seedling'`, and `?.name ?? 'Seedling'` —
  // so ANY failed read told a household paying for Greenhouse that it was on
  // Seedling, as a flat statement of fact, on the one screen it would open to
  // check exactly that. A plan name is now rendered only when the app read it.
  const planRead = resolveCurrentPlan({
    subscription: readOutcome(subQuery),
    subscriptionData: subQuery.data,
    catalog: readOutcome(plansQuery),
    plans: plansQuery.data?.plans,
  });
  // `memberCount` inside is nullable on purpose: the split line below only
  // renders from a real count, never from a placeholder.
  const usage = resolvePlanUsage(subQuery.data);
  // Three outcomes, three messages. `over` is genuinely over the plan caps —
  // only possible after a downgrade; reads, edits, and deletes all keep
  // working, only adding is blocked server-side. `unknown` means a counter
  // didn't load: the card says so instead of staying silent, because silence
  // here reads as "you're fine".
  const limits = evaluatePlanLimits(usage);
  // A live recurring subscription must be changed in the portal, never by a
  // second purchase. Mirrors the server-side guard that returns 409.
  // Mirrors the server guard, including its fail-closed treatment of an
  // unknown status: checkout.session.completed records the subscription id
  // without a status, so there is a window where the household holds a live
  // subscription the row cannot yet describe. Offering a purchase button there
  // would earn a 409 at best and a second concurrent subscription at worst.
  const hasLiveSubscription =
    !!subQuery.data?.stripeSubscriptionId &&
    (!subQuery.data.status || LIVE_SUBSCRIPTION_STATUSES.has(subQuery.data.status));
  // The identification top-up pack (ADR 0019). Shown when it is for sale
  // here, or when the household already holds credits it should be able to
  // see. Older backends publish neither; then nothing renders.
  const topUpOffer = plansQuery.data?.identifyTopUp;
  const identifyCredits = subQuery.data?.identifyCredits;
  const showTopUp =
    !native &&
    !!topUpOffer &&
    (topUpOffer.available || (!!identifyCredits && identifyCredits.remaining > 0));

  return (
    <div className="space-y-6">
      {/* Driven by the API's status, not the compile-time constant: a frontend
          deployed ahead of the backend must still say "paused" while the
          server is refusing payment activity. */}
      {!paymentsAvailable && (
        <Alert variant="info" className="flex items-start gap-3">
          <SparklesIcon className="h-5 w-5 shrink-0 mt-0.5 text-primary-700" />
          <div>
            <p className="font-semibold">{t('settings.billing.holdTitle')}</p>
            {/* Same split as CommercialHoldNotice: cite the repository hold
                only while it is actually in force. Once it lifts, this banner
                means "this environment cannot take payments right now", and
                the hold's own message no longer describes that. */}
            <p className="mt-1 text-sm">
              {COMMERCIAL_HOLD_ACTIVE
                ? t('commercialHold.message')
                : t('commercialHold.unavailableMessage')}
            </p>
            {COMMERCIAL_HOLD_ACTIVE && (
              <p className="mt-1 text-xs text-gray-600">
                {t('settings.billing.holdEffective', { date: COMMERCIAL_HOLD_EFFECTIVE_DATE })}
              </p>
            )}
          </div>
        </Alert>
      )}
      {purchaseErrorKeyState && (
        <Alert variant="error" title={t('settings.billing.purchaseErrorTitle')}>
          <p>{t(purchaseErrorKeyState)}</p>
        </Alert>
      )}
      <Card>
        <CardHeader title="Plan status" description="View your household's current plan limits." />
        {limits.overall === 'over' && (
          <Alert variant="warning" title={t('settings.billing.overLimitTitle')} className="mb-4">
            <p>{t('settings.billing.overLimitBody')}</p>
          </Alert>
        )}
        {/* Suppressed while the plan itself is unknown: the notice below
            already says the counts could not be checked, and two alerts making
            the same point is noise, not honesty. */}
        {limits.overall === 'unknown' && !planRead.unavailable && (
          <Alert variant="info" title={t('settings.billing.limitUnknownTitle')} className="mb-4">
            <p>{t('settings.billing.limitUnknownBody')}</p>
          </Alert>
        )}
        {planRead.unavailable ? (
          <div data-testid="plan-unavailable">
            <Alert variant="warning" title={t('settings.billing.planUnknownTitle')}>
              <p>{t('settings.billing.planUnknownBody')}</p>
            </Alert>
          </div>
        ) : planRead.status === 'ready' ? (
          <p className="text-sm text-gray-600" data-testid="current-plan">
            {subQuery.data?.status === 'trialing'
              ? t('settings.billing.currentPlanTrial', { plan: planRead.planName })
              : t('settings.billing.currentPlan', { plan: planRead.planName })}
          </p>
        ) : null}
        {/* A trial that does not say when it ends is a surprise charge with
            extra steps. Only shown when the household has NOT already
            cancelled — the cancellation notice below is the more useful
            message in that case, and two dates would contradict each other. */}
        {subQuery.data?.status === 'trialing' &&
          !subQuery.data?.cancelAtPeriodEnd &&
          subQuery.data?.currentPeriodEnd && (
            <p className="mt-1 text-sm text-gray-600">
              {t('settings.billing.trialEnds', {
                date: formatDate(subQuery.data.currentPeriodEnd),
              })}
            </p>
          )}
        {/* Stripe keeps a cancelled subscription serving until the period
            ends, so `status` stays active/trialing and nothing else on this
            page changes. Without this line a household that cancelled sees no
            acknowledgement at all and reasonably assumes it failed. */}
        {subQuery.data?.cancelAtPeriodEnd && (
          <Alert variant="warning" className="mt-4">
            <p>
              {/* Reached only from a settled subscription read, so `planId`
                  is real. The catalog name is preferred; the raw tier id is
                  the fallback because it was READ, not defaulted. */}
              {subQuery.data.currentPeriodEnd
                ? t('settings.billing.cancelPending', {
                    plan: planRead.planName ?? subQuery.data.planId,
                    date: formatDate(subQuery.data.currentPeriodEnd),
                  })
                : t('settings.billing.cancelPendingNoDate', {
                    plan: planRead.planName ?? subQuery.data.planId,
                  })}
            </p>
          </Alert>
        )}
        {usage && <UsageMeters usage={usage} limits={limits} />}
        {native && (
          <p className="mt-4 text-sm text-gray-600">{t('settings.billing.nativeUnavailable')}</p>
        )}
        {!paymentsAvailable && (
          <p className="mt-4 text-sm text-gray-600">{t('settings.billing.noActionAvailable')}</p>
        )}
        {/* The portal is the ONLY way to change or cancel a live subscription;
            the API rejects a second purchase with 409 to avoid billing a
            household twice. Shown whenever a Stripe customer exists, including
            after cancellation, so past customers can still reach invoices. */}
        {paymentsAvailable && !native && subQuery.data?.stripeCustomerId && (
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={() => portalMutation.mutate()}
              isLoading={portalMutation.isPending}
              disabled={!isAdmin || portalMutation.isPending}
            >
              {t('settings.billing.managePlan')}
            </Button>
            {!isAdmin && (
              <p className="mt-2 text-sm text-gray-600">{t('settings.billing.adminOnlyBilling')}</p>
            )}
          </div>
        )}
      </Card>

      {showTopUp && topUpOffer && (
        <div>
          {returnedFromTopUp && (
            <Alert variant="info" className="mb-4">
              <p>{t('identifyTopUp.purchaseReturned')}</p>
            </Alert>
          )}
          <IdentifyTopUpCard
            variant="billing"
            available={paymentsAvailable && topUpOffer.available}
            credits={topUpOffer.credits}
            priceUsd={topUpOffer.priceUsd ?? null}
            validityDays={topUpOffer.validityDays}
            balance={identifyCredits === undefined ? null : identifyCredits}
          />
        </div>
      )}

      {paymentsAvailable && !native && (
        <Card>
          <CardHeader
            title={t('settings.billing.changePlanTitle')}
            description={t('settings.billing.changePlanDescription')}
          />
          {/* Fail closed, for the same reason `hasLiveSubscription` does: with
              the subscription read unsettled we do not know what the household
              already has, so every CTA here would be a guess — "this is your
              current plan" on a tier it is not on, or a purchase button for one
              it already pays for. */}
          {planRead.unavailable ? (
            <p className="mt-4 text-sm text-gray-600" data-testid="change-plan-unavailable">
              {t('settings.billing.changePlanUnavailable')}
            </p>
          ) : planRead.status !== 'ready' ? null : (
            <PaidPlanGrid
              plans={plans}
              currentPlanId={planRead.planId ?? undefined}
              renderCta={(plan, interval, price) => (
                <>
                  {/* "$X ÷ N members = $Y each" from the live price and the
                    real member count (brief §4.12). Hides itself for a
                    household of one or an unknown count. */}
                  {plan.id !== 'seedling' && price !== null && price > 0 && (
                    <SplitTheBill
                      amount={price}
                      interval={interval}
                      planName={plan.name}
                      memberCount={usage?.memberCount ?? null}
                      householdName={householdName}
                    />
                  )}
                  {renderPlanCta({
                    plan,
                    interval,
                    price,
                    currentPlanId: planRead.planId,
                    lifetimePlanId: subQuery.data?.lifetimePlanId,
                    isAdmin,
                    hasLiveSubscription,
                    t,
                    isPending: checkoutMutation.isPending,
                    pendingPlanId: checkoutMutation.variables?.planId,
                    onSelect: () =>
                      checkoutMutation.mutate({
                        planId: plan.id as 'garden' | 'greenhouse',
                        interval,
                      }),
                  })}
                </>
              )}
            />
          )}
        </Card>
      )}
    </div>
  );
}

/** Stable identity for a catalog that was not read. Never an answer — see
 *  `planRead` above, which carries whether the read settled at all. */
const EMPTY_PLANS: Plan[] = [];

/**
 * The call to action for one tier, which has more "no button" cases than
 * button cases. Each returns a reason rather than rendering nothing, because
 * a bare missing button reads as a bug to the person looking for it.
 */
function renderPlanCta({
  plan,
  interval,
  price,
  currentPlanId,
  lifetimePlanId,
  isAdmin,
  hasLiveSubscription,
  isPending,
  pendingPlanId,
  onSelect,
  t,
}: {
  plan: Plan;
  interval: BillingInterval;
  price: number | null;
  /** `null` when the subscription read did not settle with a tier. Callers
   *  must not substitute one — see `planRead` in BillingSettings. */
  currentPlanId: PlanId | null;
  lifetimePlanId?: PlanId;
  isAdmin: boolean;
  hasLiveSubscription: boolean;
  isPending: boolean;
  pendingPlanId?: string;
  onSelect: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  // The free tier is never purchased; households arrive on it by default or
  // return to it by cancelling in the portal.
  if (plan.id === 'seedling') {
    return currentPlanId === 'seedling' ? null : (
      <p className="text-sm text-gray-600">{t('settings.billing.cancelToReturn')}</p>
    );
  }
  // Owned outright already — at this tier or a lower one. The server refuses
  // these with a 409, but the UI must not offer them at all: a lifetime
  // purchase has no subscription id, so the live-subscription guard below
  // cannot see it, and without this a household would be invited to buy again
  // something it has already paid for permanently.
  if (lifetimePlanId && planRank(plan.id) <= planRank(lifetimePlanId)) {
    return <p className="text-sm text-gray-600">{t('settings.billing.ownedForLife')}</p>;
  }
  // Converting a live subscription to a one-time lifetime purchase on the SAME
  // tier is a real upgrade the API supports on purpose (the lifetime webhook
  // cancels the prior subscription), so "this is your current plan" must not
  // swallow it. A household already holding lifetime has no live subscription,
  // so this correctly stops offering it once bought.
  const canConvertToLifetime = interval === 'lifetime' && hasLiveSubscription && price !== null;
  if (currentPlanId === plan.id && !canConvertToLifetime) {
    return <p className="text-sm text-gray-600">{t('settings.billing.currentPlanNote')}</p>;
  }
  // Not sold at this cadence — a blank price id is a deliberate partial launch.
  if (price === null) return null;
  if (!isAdmin) {
    // A member cannot buy, but can ask (brief §7d): one tap sends the admins
    // a note naming this plan. Billing itself stays admin-only.
    return (
      <div className="space-y-2">
        <p className="text-sm text-gray-600">{t('settings.billing.adminOnlyPlan')}</p>
        <AskToUpgrade feature={plan.id === 'greenhouse' ? 'greenhouse_plan' : 'garden_plan'} />
      </div>
    );
  }
  // A lifetime purchase is exempt: its webhook cancels the prior subscription,
  // so it is the one paid path that may run alongside a live one.
  if (hasLiveSubscription && interval !== 'lifetime') {
    return (
      <p className="text-sm text-gray-600">
        {t('settings.billing.usePortalToSwitch', { plan: plan.name })}
      </p>
    );
  }
  return (
    <Button
      onClick={onSelect}
      isLoading={isPending && pendingPlanId === plan.id}
      disabled={isPending}
      className="w-full"
    >
      {interval === 'lifetime'
        ? currentPlanId === plan.id
          ? t('settings.billing.convertToLifetime', { plan: plan.name })
          : t('settings.billing.buyLifetime', { plan: plan.name })
        : t('settings.billing.switchTo', { plan: plan.name })}
    </Button>
  );
}

/**
 * Ambient "n of max" meters for the household's plan caps. Three states per
 * row, never two: a number (including a genuine 0) with a bar, or an explicit
 * "usage unavailable" with no bar. Bars turn red when over the cap
 * (post-downgrade) — purely informational, the server enforces. The
 * over/within/unknown decision comes from the same `evaluatePlanLimits` call
 * that drives the banner, so a row and the banner cannot disagree.
 */
function UsageMeters({ usage, limits }: { usage: PlanUsageDetail; limits: PlanLimitEvaluation }) {
  const { t } = useTranslation();
  // A null CAP is unlimited (Garden and Greenhouse members, ADR 0014): the
  // row states the count with no ceiling and draws no bar, because there is
  // nothing to fill. A null COUNT is still "unknown" and still says so.
  const meters = [
    {
      key: 'plants',
      label:
        usage.maxPlants === null
          ? usage.plantCount === null
            ? t('settings.billing.plantsCountUnavailable')
            : t('settings.billing.plantsUsageUnlimited', { n: usage.plantCount })
          : usage.plantCount === null
            ? t('settings.billing.plantsUsageUnavailable', { max: usage.maxPlants })
            : t('settings.billing.plantsUsage', {
                n: usage.plantCount,
                max: usage.maxPlants,
              }),
      count: usage.plantCount,
      max: usage.maxPlants,
      state: limits.plants,
    },
    {
      key: 'members',
      label:
        usage.maxMembers === null
          ? usage.memberCount === null
            ? t('settings.billing.membersCountUnavailable')
            : t('settings.billing.membersUsageUnlimited', { n: usage.memberCount })
          : usage.memberCount === null
            ? t('settings.billing.membersUsageUnavailable', { max: usage.maxMembers })
            : t('settings.billing.membersUsage', {
                n: usage.memberCount,
                max: usage.maxMembers,
              }),
      count: usage.memberCount,
      max: usage.maxMembers,
      state: limits.members,
    },
  ];
  return (
    <div className="mt-4" data-testid="usage-meters">
      <p id="billing-usage-title" className="text-sm font-medium text-gray-700">
        {t('settings.billing.usageTitle')}
      </p>
      <div className="mt-3 space-y-3" role="list" aria-labelledby="billing-usage-title">
        {meters.map((m) => {
          // A bar needs both a count and a ceiling; unlimited has no ceiling.
          const available = m.state !== 'unknown' && m.count !== null && m.max !== null;
          const over = m.state === 'over';
          const pct =
            m.count !== null && m.max !== null && m.max > 0
              ? Math.min(100, Math.round((m.count / m.max) * 100))
              : 0;
          return (
            <div
              key={m.key}
              role="listitem"
              data-testid={`usage-meter-${m.key}`}
              data-state={m.state}
            >
              <p className={clsx('text-xs', over ? 'text-red-600 font-medium' : 'text-gray-600')}>
                {m.label}
              </p>
              {available && (
                <div
                  className="mt-1 h-1.5 w-full max-w-xs rounded-full bg-primary-100/60"
                  role="presentation"
                  data-testid={`usage-meter-${m.key}-bar`}
                >
                  <div
                    className={clsx('h-1.5 rounded-full', over ? 'bg-red-500' : 'bg-primary-500')}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
