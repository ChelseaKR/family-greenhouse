import { api } from './api';
import { COMMERCIAL_HOLD_ACTIVE, COMMERCIAL_HOLD_EFFECTIVE_DATE } from '@/config/commercialStatus';

export type PlanId = 'seedling' | 'garden' | 'greenhouse';

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  maxPlants: number;
  maxMembers: number;
}

export interface PlanCatalog {
  paymentsAvailable: boolean;
  commercialHold: {
    active: boolean;
    effectiveDate: string;
  };
  plans: Plan[];
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
};
