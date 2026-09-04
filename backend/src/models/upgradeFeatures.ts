/**
 * The closed vocabulary of paid features a MEMBER can ask an admin to
 * upgrade for, plus the pure resolution + copy that both the Lambda service
 * (services/upgradeRequests.ts) and the local dev server share.
 *
 * Pure on purpose: no DynamoDB, no SES. The dev server imports this module
 * directly and must not drag `utils/dynamodb` (which requires TABLE_NAME at
 * load) into its process.
 *
 * Adding a new lockable surface (the ideation wave's Away Kit, Plant Tags,
 * coverage view, …) is three small steps:
 *   1. add its id + `minimumPlan` to `FEATURE_CATALOG` below (with a label);
 *   2. add `locked.features.<id>` to BOTH i18n catalogs (en + es);
 *   3. wrap the gated UI in `<LockedFeature feature="<id>">`.
 */
import {
  getPlan,
  planRank,
  isUnlimited,
  limitOf,
  PLAN_ORDER,
  PLANS,
  type Limit,
  type PlanId,
} from './plans.js';

/**
 * Is `candidate` a strictly higher ceiling than `current`? Caps are `Limit`
 * since ADR 0014, where `null` is UNLIMITED — the largest value there is, not
 * a missing one. Comparing them with `>` would coerce `null` to 0 and make
 * "unlimited plants" read as the smallest cap on offer, so an unlimited tier
 * would never be offered as the answer to "room for more plants".
 */
function raisesCap(candidate: Limit, current: Limit): boolean {
  if (isUnlimited(candidate)) return !isUnlimited(current);
  if (isUnlimited(current)) return false;
  return candidate > current;
}

/**
 * The request body is validated against this list, so the email/push copy is
 * always built from server-side labels — a member can never put free text in
 * front of an admin.
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

export function isUpgradeFeature(value: unknown): value is UpgradeFeature {
  return typeof value === 'string' && (UPGRADE_FEATURES as readonly string[]).includes(value);
}

/** A tier a member can ask for. The free tier is never a target. */
export type PaidPlanId = Exclude<PlanId, 'seedling'>;

export interface FeatureSpec {
  /** Plain-English name used in the email + push copy (the UI has its own
   *  i18n keys under `locked.features`). */
  label: string;
  /**
   * The lowest tier that includes the feature, or `'next_plant_cap'` /
   * `'next_member_cap'` for cap-shaped features whose answer depends on the
   * household's CURRENT plan — those are resolved against the catalog at
   * request time rather than pinned here, so a re-cut of the caps in
   * models/plans.ts never leaves this file lying.
   */
  minimumPlan: PaidPlanId | 'next_plant_cap' | 'next_member_cap';
}

export const FEATURE_CATALOG: Record<UpgradeFeature, FeatureSpec> = {
  chat: { label: 'Plant care chat', minimumPlan: 'garden' },
  identifications: { label: 'More plant identifications each month', minimumPlan: 'garden' },
  leaf_health: { label: 'More leaf-health checks each month', minimumPlan: 'garden' },
  plant_cap: { label: 'Room for more plants', minimumPlan: 'next_plant_cap' },
  member_cap: { label: 'Room for more household members', minimumPlan: 'next_member_cap' },
  api_keys: { label: 'API keys', minimumPlan: 'greenhouse' },
  garden_plan: { label: 'The Garden plan', minimumPlan: 'garden' },
  greenhouse_plan: { label: 'The Greenhouse plan', minimumPlan: 'greenhouse' },
};

/** A member may ask about one feature once per window. */
export const REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The tier a request for `feature` is actually asking for, given what the
 * household already has. `null` when no higher tier lifts it — either the
 * household already includes the feature, or (for a cap) no tier above the
 * current one raises that cap.
 */
export function resolveTargetPlan(
  feature: UpgradeFeature,
  currentPlanId: PlanId
): PaidPlanId | null {
  const spec = FEATURE_CATALOG[feature];
  const current = getPlan(currentPlanId);
  if (spec.minimumPlan === 'next_plant_cap' || spec.minimumPlan === 'next_member_cap') {
    const cap = spec.minimumPlan === 'next_plant_cap' ? 'plants' : 'members';
    for (const id of PLAN_ORDER) {
      // Strictly above the current tier, so the free tier can never be the
      // answer (its rank is the floor).
      if (
        id !== 'seedling' &&
        planRank(id) > planRank(current.id) &&
        raisesCap(limitOf(PLANS[id], cap), limitOf(current, cap))
      ) {
        return id;
      }
    }
    return null;
  }
  return planRank(current.id) >= planRank(spec.minimumPlan) ? null : spec.minimumPlan;
}

/**
 * Compose the admin-facing email. Pure so the copy is testable without SES.
 * Plain text, like every other email this app sends. `appUrl` is the
 * FRONTEND_URL base (trailing slash tolerated).
 */
export function composeUpgradeRequestEmail(input: {
  adminName: string;
  memberName: string;
  householdName: string;
  feature: UpgradeFeature;
  targetPlanId: PaidPlanId;
  appUrl: string;
}): { subject: string; text: string } {
  const base = input.appUrl.replace(/\/+$/, '');
  const plan = getPlan(input.targetPlanId);
  const featureLabel = FEATURE_CATALOG[input.feature].label;
  const greeting = input.adminName.trim() ? `Hi ${input.adminName.trim()},` : 'Hi there,';
  const subject = `${input.memberName} asked to upgrade ${input.householdName}`;
  const text = [
    greeting,
    '',
    `${input.memberName} ran into something that is not on your household's current plan and asked you to upgrade:`,
    '',
    `  ${featureLabel}`,
    '',
    `It is included with the ${plan.name} plan, $${plan.monthlyPrice.toFixed(2)} a month for the whole household.`,
    '',
    `Review plans and upgrade: ${base}/settings/billing`,
    '',
    `You are getting this because you are an admin of ${input.householdName}. Nothing has been`,
    'charged; only an admin can change the plan. A member can ask about a feature once a week.',
    '',
    'The Family Greenhouse team',
  ].join('\n');
  return { subject, text };
}

/** The push payload every admin gets alongside the email. */
export function composeUpgradeRequestPush(input: {
  memberName: string;
  householdName: string;
  feature: UpgradeFeature;
  targetPlanId: PaidPlanId;
  appUrl: string;
  householdId: string;
}): { title: string; body: string; url: string; tag: string } {
  const base = input.appUrl.replace(/\/+$/, '');
  const plan = getPlan(input.targetPlanId);
  return {
    title: `${input.memberName} asked to upgrade ${input.householdName}`,
    body: `${FEATURE_CATALOG[input.feature].label} is included with ${plan.name}. Open Settings → Billing to review.`,
    url: `${base}/settings/billing`,
    tag: `upgrade-request:${input.householdId}:${input.feature}`,
  };
}
