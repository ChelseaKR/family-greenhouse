import {
  effectivePlanId,
  resolvePlanUsage,
  type Plan,
  type SubscriptionState,
} from '@/services/billingService';

/** The two household caps a person can run into while adding. */
export type HouseholdCap = 'plants' | 'members';

export interface CapReached {
  /** How many the household has now (active plants, or people). */
  count: number;
  /** The ceiling the server ENFORCES for this household, from GET /billing/me. */
  max: number;
}

/**
 * Whether the household is at (or above) one of its caps, read from the caps
 * the server actually enforces for it (`usageDetail`), never from the catalog.
 *
 * The catalog states what a NEW household on each tier gets. A household
 * created before the 2026-10-23 Seedling cut is held to 20 plants and 3
 * people, not the catalog's 8 and 2 (ADR 0040), and only the usage block
 * knows that. Reading the catalog here would tell a 9-plant grandfathered
 * household it is full when it has room for eleven more.
 *
 * `null` unless BOTH numbers were read and the count has reached the ceiling.
 * An unlimited cap (`null`) is never reached, and an unread counter is not
 * evidence of being full: no prompt is better than a wrong one.
 */
export function capReached(
  subscription: SubscriptionState | null | undefined,
  cap: HouseholdCap
): CapReached | null {
  const usage = resolvePlanUsage(subscription);
  if (!usage) return null;
  const count = cap === 'plants' ? usage.plantCount : usage.memberCount;
  const max = cap === 'plants' ? usage.maxPlants : usage.maxMembers;
  if (typeof count !== 'number' || typeof max !== 'number') return null;
  return count >= max ? { count, max } : null;
}

/**
 * The free caps a grandfathered Seedling household keeps, or `null`.
 *
 * Present only when the household is on Seedling right now and the server
 * enforces a higher plant or member cap for it than the catalog lists for
 * Seedling, which happens for exactly one reason: the household was created
 * before the 2026-10-23 cut and kept 20 plants and 3 people (ADR 0040).
 * Derived from the two reads the billing page already makes, so there is no
 * extra field on the wire to drift from what the server enforces.
 */
export function grandfatheredFreeCaps(
  subscription: SubscriptionState | null | undefined,
  plans: Plan[] | undefined
): { plants: number; members: number; newPlants: number; newMembers: number } | null {
  if (effectivePlanId(subscription) !== 'seedling') return null;
  const usage = resolvePlanUsage(subscription);
  const catalog = plans?.find((p) => p.id === 'seedling');
  if (!usage || !catalog) return null;
  const catalogPlants = catalog.limits ? catalog.limits.plants : catalog.maxPlants;
  const catalogMembers = catalog.limits ? catalog.limits.members : catalog.maxMembers;
  if (
    typeof usage.maxPlants !== 'number' ||
    typeof usage.maxMembers !== 'number' ||
    typeof catalogPlants !== 'number' ||
    typeof catalogMembers !== 'number'
  ) {
    return null;
  }
  if (usage.maxPlants <= catalogPlants && usage.maxMembers <= catalogMembers) return null;
  return {
    plants: usage.maxPlants,
    members: usage.maxMembers,
    newPlants: catalogPlants,
    newMembers: catalogMembers,
  };
}
