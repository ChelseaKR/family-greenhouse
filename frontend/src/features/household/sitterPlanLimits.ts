import type { PlanId } from '@/services/billingService';

/**
 * Sitter-link caps per plan, for the create form's `max` and helper copy.
 *
 * This MIRRORS `backend/src/models/plans.ts` → `limits`; the backend is the
 * authority and refuses an over-cap request with 402 regardless of what this
 * table says. The client copy exists so the traveller learns the cap while
 * typing, not after submitting — and so the free tier's wall reads as the
 * upgrade prompt it is (ADR 0015). Keep the two in step.
 */
export interface SitterLinkLimits {
  planId: PlanId;
  /** Longest coverage window, in days. */
  maxDays: number;
  /** How many links may be live (active or scheduled) at once. */
  maxActive: number;
}

const LIMITS: Record<PlanId, Omit<SitterLinkLimits, 'planId'>> = {
  seedling: { maxDays: 7, maxActive: 1 },
  garden: { maxDays: 90, maxActive: 10 },
  greenhouse: { maxDays: 90, maxActive: 25 },
};

/** The absolute ceiling any plan allows; used only to bound the input. */
export const SITTER_LINK_MAX_DAYS_CEILING = 90;

/**
 * Limits for a known plan, or null for an id this build does not recognise.
 * Callers must treat null as "unknown" — never as the free tier and never as
 * unlimited — and say so in the UI.
 */
export function sitterLinkLimitsFor(planId: string | null | undefined): SitterLinkLimits | null {
  if (!planId || !Object.hasOwn(LIMITS, planId)) return null;
  const id = planId as PlanId;
  return { planId: id, ...LIMITS[id] };
}
