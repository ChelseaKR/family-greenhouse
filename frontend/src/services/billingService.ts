import { api } from './api';
import { COMMERCIAL_HOLD_ACTIVE, COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';

export type PlanId = 'seedling' | 'garden' | 'greenhouse';

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  maxPlants: number;
  maxMembers: number;
  /** Price fields are present ONLY when the API reports paymentsAvailable —
   *  see planSummary() in backend/src/models/plans.ts, which omits them
   *  entirely while payment activity is disabled. `null` is the explicit
   *  "this tier has no such cadence" signal (free tier, or Greenhouse
   *  lifetime); `undefined` means prices are being withheld altogether. */
  monthlyPrice?: number;
  annualPrice?: number | null;
  lifetimePrice?: number | null;
}

/** Billing cadence accepted by POST /billing/checkout. */
export type BillingInterval = 'month' | 'year' | 'lifetime';

export interface PlanCatalog {
  paymentsAvailable: boolean;
  commercialHold: {
    active: boolean;
    effectiveDate: string;
  };
  plans: Plan[];
}

/** Legacy numeric-only usage shape from GET /billing/me. */
export interface PlanUsage {
  plantCount: number;
  maxPlants: number;
  memberCount: number;
  maxMembers: number;
}

/** Nullable usage shape for counters that may be unseeded or unavailable. */
export interface PlanUsageDetail {
  plantCount: number | null;
  maxPlants: number;
  memberCount: number | null;
  maxMembers: number;
}

export interface SubscriptionState {
  planId: PlanId;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
  /** Legacy shape: present only when both counters are known. */
  usage?: PlanUsage;
  /** Additive nullable shape. Older backends do not send it. */
  usageDetail?: PlanUsageDetail;
}

/** Prefer the nullable contract, with rolling-deploy fallback to legacy usage. */
export function resolvePlanUsage(
  subscription?: SubscriptionState | null
): PlanUsageDetail | undefined {
  return subscription?.usageDetail ?? subscription?.usage;
}

/**
 * Where a household sits against one plan cap. `unknown` is a first-class
 * answer and is deliberately NOT collapsed into `within`: an unreadable
 * counter is not evidence that the household is under its limit, and a
 * boolean cannot hold that difference (#308).
 */
export type PlanLimitState = 'within' | 'over' | 'unknown';

export interface PlanLimitEvaluation {
  plants: PlanLimitState;
  members: PlanLimitState;
  /**
   * The state to speak to the user: a known overage outranks an unknown
   * counter (it is actionable), and `unknown` outranks `within` (we cannot
   * claim they are inside their caps while a counter is missing).
   */
  overall: PlanLimitState;
}

function limitState(count: number | null | undefined, max: number): PlanLimitState {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 'unknown';
  return count > max ? 'over' : 'within';
}

/**
 * Evaluate the household against its plan caps — only breached after a
 * downgrade (or an admin-side plan change). Existing data stays
 * readable/editable; only adding is blocked server-side.
 *
 * Each dimension is evaluated independently, so an unknown member count
 * neither manufactures a warning nor hides a known plant overage.
 */
export function evaluatePlanLimits(usage?: PlanUsageDetail | null): PlanLimitEvaluation {
  if (!usage) {
    // No usage in the response at all (older backend, or still loading). We
    // know nothing, and say so rather than implying compliance.
    return { plants: 'unknown', members: 'unknown', overall: 'unknown' };
  }
  const plants = limitState(usage.plantCount, usage.maxPlants);
  const members = limitState(usage.memberCount, usage.maxMembers);
  const overall: PlanLimitState =
    plants === 'over' || members === 'over'
      ? 'over'
      : plants === 'unknown' || members === 'unknown'
        ? 'unknown'
        : 'within';
  return { plants, members, overall };
}

export const billingService = {
  async listPlans(): Promise<PlanCatalog> {
    const response = await api.get<PlanCatalog | Plan[]>('/billing/plans');
    if (Array.isArray(response.data)) {
      // Rolling-deploy compatibility: the prior API returned a bare array with
      // price fields. Strip it to the noncommercial plan projection and fail
      // closed until the new status-bearing API is live.
      return {
        paymentsAvailable: false,
        commercialHold: {
          active: COMMERCIAL_HOLD_ACTIVE,
          effectiveDate: COMMERCIAL_HOLD_EFFECTIVE_DATE,
        },
        plans: response.data.map(({ id, name, description, maxPlants, maxMembers }) => ({
          id,
          name,
          description,
          maxPlants,
          maxMembers,
        })),
      };
    }
    return response.data;
  },

  async getCurrentSubscription(): Promise<SubscriptionState> {
    const response = await api.get<SubscriptionState>('/billing/me');
    return response.data;
  },

  /**
   * Start a Stripe Checkout session and return the URL to redirect to.
   *
   * `checkoutAttemptId` is generated once per click and forwarded as Stripe's
   * idempotency key, so a retried request (flaky network, double-click, the
   * browser replaying a request) returns the SAME session instead of opening
   * a second one. Callers must generate it at click time, not per render.
   *
   * The server re-checks both commercial gates before touching Stripe and
   * answers 503 when payment activity is off, so a stale client that still
   * shows a buy button cannot originate a charge.
   */
  async createCheckout(input: {
    planId: Exclude<PlanId, 'seedling'>;
    interval: BillingInterval;
    checkoutAttemptId: string;
  }): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/checkout', input);
    return response.data;
  },

  /**
   * Create a Stripe billing-portal session for the household's existing
   * customer record. Only meaningful after a completed checkout — the API
   * answers 400 when no Stripe customer is on file.
   */
  async createPortalSession(): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/portal', {});
    return response.data;
  },
};
