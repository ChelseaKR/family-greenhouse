import { api } from './api';
import { track } from './analytics';
import type { Plan, PlanId } from './billingService';

/**
 * Member → admin upgrade requests (POST /households/:id/upgrade-requests).
 *
 * Billing is admin-only, so a member who hits a paid feature has no way to
 * buy it. This is the ask: it names the feature, the server tells every admin
 * (in-app push + email + activity row), and the server refuses a repeat for
 * the same member + feature inside 7 days. Nothing here touches money.
 *
 * The feature vocabulary mirrors backend/src/models/upgradeFeatures.ts — the
 * server validates against its own copy, so an id that is not there is a 400,
 * never free text in front of an admin.
 */
export const UPGRADE_FEATURES = [
  'chat',
  'identifications',
  'leaf_health',
  'plant_cap',
  'member_cap',
  'api_keys',
  'garden_plan',
  'greenhouse_plan',
] as const;

export type UpgradeFeature = (typeof UPGRADE_FEATURES)[number];

/** A tier a member can ask for. The free tier is never a target. */
export type PaidPlanId = Exclude<PlanId, 'seedling'>;

const PLAN_ORDER: PlanId[] = ['seedling', 'garden', 'greenhouse'];
const rank = (id: PlanId) => PLAN_ORDER.indexOf(id);

/** Features whose tier does not depend on the household's current caps. */
const FIXED_MINIMUM_PLAN: Partial<Record<UpgradeFeature, PaidPlanId>> = {
  chat: 'garden',
  identifications: 'garden',
  leaf_health: 'garden',
  api_keys: 'greenhouse',
  garden_plan: 'garden',
  greenhouse_plan: 'greenhouse',
};

/**
 * The tier a request for `feature` would ask for, given the household's
 * current plan and the live catalog. Mirrors the server's resolution so the
 * locked card can say "Included with Garden" before the ask is sent. `null`
 * means no higher tier lifts it (already included, or no tier raises the cap)
 * — and `null` is also the answer while the catalog is unknown, because a
 * tier name should never be guessed.
 */
export function resolveTargetPlan(
  feature: UpgradeFeature,
  currentPlanId: PlanId,
  plans: Plan[] | undefined
): PaidPlanId | null {
  const fixed = FIXED_MINIMUM_PLAN[feature];
  if (fixed) return rank(currentPlanId) >= rank(fixed) ? null : fixed;
  if (!plans) return null;
  const cap = feature === 'plant_cap' ? 'maxPlants' : 'maxMembers';
  const current = plans.find((p) => p.id === currentPlanId);
  if (!current) return null;
  for (const id of PLAN_ORDER) {
    if (id === 'seedling' || rank(id) <= rank(currentPlanId)) continue;
    const candidate = plans.find((p) => p.id === id);
    if (candidate && candidate[cap] > current[cap]) return id;
  }
  return null;
}

export interface UpgradeRequestResult {
  feature: UpgradeFeature;
  targetPlanId: PaidPlanId;
  requestedAt: string;
  nextAllowedAt: string;
  /** The admins who were told — names only. */
  admins: Array<{ userId: string; name: string }>;
  /** False means no email left the building (failed OR unconfigured). */
  emailDelivered: boolean;
  pushDelivered: boolean;
}

export const upgradeRequestService = {
  async request(householdId: string, feature: UpgradeFeature): Promise<UpgradeRequestResult> {
    const response = await api.post<UpgradeRequestResult>(
      `/households/${householdId}/upgrade-requests`,
      { feature }
    );
    // Recorded after the server accepted it: a 429/409/503 is not an ask
    // that reached an admin. `upgradeTo` is the same closed enum checkout
    // already reports, so the funnel can pair asks with later purchases.
    track('upgrade_requested', { upgradeTo: response.data.targetPlanId });
    return response.data;
  },
};

export type UpgradeRequestFailure =
  | { kind: 'already_asked'; nextAllowedAt: string | null }
  | { kind: 'already_included' }
  | { kind: 'payments_paused' }
  | { kind: 'failed' };

/**
 * Map the API's refusals onto something the member can act on. The server is
 * the authority on all of them; none is fixed by retrying unchanged.
 */
export function classifyUpgradeRequestError(error: unknown): UpgradeRequestFailure {
  const response = (
    error as {
      response?: { status?: number; data?: { details?: { nextAllowedAt?: unknown } } };
    }
  )?.response;
  switch (response?.status) {
    case 429: {
      const next = response.data?.details?.nextAllowedAt;
      return { kind: 'already_asked', nextAllowedAt: typeof next === 'string' ? next : null };
    }
    case 409:
      return { kind: 'already_included' };
    case 503:
      return { kind: 'payments_paused' };
    default:
      return { kind: 'failed' };
  }
}
