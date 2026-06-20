import { api } from './api';
import { track } from './analytics';

export type PlanId = 'seedling' | 'garden' | 'greenhouse';

/** Billing cadence sent to /billing/checkout. */
export type BillingInterval = 'month' | 'year';

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  monthlyPrice: number;
  /** Yearly price in dollars, or null when the tier has no annual option
   *  (free tier). */
  annualPrice: number | null;
  maxPlants: number;
  maxMembers: number;
}

/** Current usage vs. the active plan's caps, from GET /billing/me. */
export interface PlanUsage {
  plantCount: number;
  maxPlants: number;
  memberCount: number;
  maxMembers: number;
}

export interface SubscriptionState {
  planId: PlanId;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
  /** Optional: older backends don't send it; treat absence as "unknown". */
  usage?: PlanUsage;
}

/**
 * True when the household holds more plants or members than its current plan
 * allows — only possible after a downgrade (or an admin-side plan change).
 * Existing data stays readable/editable; only adding is blocked server-side.
 */
export function isOverPlanLimit(usage?: PlanUsage | null): boolean {
  if (!usage) return false;
  return usage.plantCount > usage.maxPlants || usage.memberCount > usage.maxMembers;
}

export const billingService = {
  async listPlans(): Promise<Plan[]> {
    const response = await api.get<Plan[]>('/billing/plans');
    return response.data;
  },

  async getCurrentSubscription(): Promise<SubscriptionState> {
    const response = await api.get<SubscriptionState>('/billing/me');
    return response.data;
  },

  async startCheckout(
    planId: Exclude<PlanId, 'seedling'>,
    interval: BillingInterval = 'month'
  ): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/checkout', { planId, interval });
    // Mark intent at checkout-start; the actual successful upgrade is
    // confirmed by the Stripe webhook server-side. We track intent here
    // as a leading indicator and rely on a separate `subscription_active`
    // signal (post-webhook) for billing source-of-truth.
    track('subscription_upgraded', { upgradeTo: planId, interval });
    return response.data;
  },

  async openPortal(): Promise<{ url: string }> {
    const response = await api.post<{ url: string }>('/billing/portal');
    track('subscription_canceled');
    return response.data;
  },
};
