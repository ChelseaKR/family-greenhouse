/**
 * The GA4 `purchase` for a plan checkout (docs/analytics.md, "Conversion
 * events in GA4"), reported from Settings → Billing on Stripe's return.
 *
 * Reported once the purchase has SETTLED, not on the redirect: Stripe sends
 * the buyer back before its webhook has written the subscription, and the
 * page polls until it has (BillingSettings, `awaitingEntitlement`). A settled
 * purchase is the same condition that page uses: a live subscription id, or a
 * lifetime tier owned outright.
 *
 * What it carries:
 *  - `transactionId`: a SHA-256 hash of the Stripe subscription id, or of a
 *    household-and-tier key for a lifetime purchase (`gaTransactionId`). The
 *    same purchase always hashes to the same id, so reloading the return
 *    address is one purchase in GA. No Stripe id is sent.
 *  - `plan`, `interval` and `value`: only when the return address names a
 *    plan and cadence (the backend puts them there, as validated enums) AND
 *    the settled state shows that same plan. `value` is that plan's catalog
 *    price for that cadence. On a card trial the first charge comes after the
 *    trial, so `value` is the price the buyer committed to, not money taken
 *    today. When the address names nothing, the purchase is still counted,
 *    without a value.
 */
import { useEffect, useRef } from 'react';
import type { Plan, PlanId, SubscriptionState } from '@/services/billingService';
import {
  gaTransactionId,
  trackGoogleConversion,
  type GoogleConversion,
} from '@/services/googleAnalytics';

/** Mirrors LIVE_SUBSCRIPTION_STATUSES in BillingSettings and the backend. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

type PaidPlan = Exclude<PlanId, 'seedling'>;
type Interval = 'month' | 'year' | 'lifetime';

export interface PlanPurchaseInput {
  householdId: string | null;
  subscription: SubscriptionState | undefined;
  plans: Plan[] | undefined;
  /** `plan` from the return address: untrusted, checked here. */
  plan: string | null;
  /** `interval` from the return address: untrusted, checked here. */
  interval: string | null;
}

function paidPlan(value: string | null | undefined): PaidPlan | undefined {
  return value === 'garden' || value === 'greenhouse' ? value : undefined;
}

function interval(value: string | null): Interval | undefined {
  return value === 'month' || value === 'year' || value === 'lifetime' ? value : undefined;
}

function catalogPrice(plan: Plan | undefined, cadence: Interval): number | undefined {
  if (!plan) return undefined;
  const price =
    cadence === 'lifetime'
      ? plan.lifetimePrice
      : cadence === 'year'
        ? plan.annualPrice
        : plan.monthlyPrice;
  return typeof price === 'number' ? price : undefined;
}

/** What to report for this return, or null while the purchase has not settled. */
export async function planPurchaseConversion(
  input: PlanPurchaseInput
): Promise<GoogleConversion | null> {
  const sub = input.subscription;
  if (!sub) return null;
  const named = paidPlan(input.plan);
  const cadence = interval(input.interval);

  const liveSubscription =
    !!sub.stripeSubscriptionId && (!sub.status || LIVE_SUBSCRIPTION_STATUSES.has(sub.status));
  const lifetime = paidPlan(sub.lifetimePlanId);

  let source: string;
  let bought: PaidPlan | undefined;
  if (cadence !== 'lifetime' && liveSubscription && sub.stripeSubscriptionId) {
    source = sub.stripeSubscriptionId;
    bought = paidPlan(sub.planId);
  } else if (cadence !== 'month' && cadence !== 'year' && lifetime && input.householdId) {
    source = `lifetime:${input.householdId}:${lifetime}`;
    bought = lifetime;
  } else {
    return null;
  }

  const transactionId = await gaTransactionId(source);
  if (!transactionId) return null;
  if (named && cadence && bought === named) {
    const value = catalogPrice(
      input.plans?.find((plan) => plan.id === named),
      cadence
    );
    if (value !== undefined) {
      return { name: 'purchase', transactionId, plan: named, interval: cadence, value };
    }
  }
  return { name: 'purchase', transactionId };
}

/**
 * Report the purchase once per mount of the billing page, when `returned`
 * (Stripe sent the buyer back from a plan checkout) and the purchase has
 * settled. Never inside the native apps, which load no Google Analytics.
 */
export function useReportPlanPurchase(
  input: PlanPurchaseInput & { returned: boolean; native: boolean }
): void {
  const reported = useRef(false);
  const { returned, native, householdId, subscription, plans, plan, interval: cadence } = input;
  useEffect(() => {
    if (!returned || native || reported.current) return;
    let cancelled = false;
    void planPurchaseConversion({ householdId, subscription, plans, plan, interval: cadence }).then(
      (conversion) => {
        if (cancelled || !conversion || reported.current) return;
        reported.current = true;
        trackGoogleConversion(conversion);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [returned, native, householdId, subscription, plans, plan, cadence]);
}
