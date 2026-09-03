/**
 * The homes gate — the one per-USER cap in the plan catalog (ADR 0014).
 *
 * `limits.homes` says how many households a person may belong to. Plans are
 * per household, so a person who belongs to several households on different
 * plans holds several entitlements at once; the STRONGEST one applies, and
 * the household being joined counts as one the person would hold. Two
 * consequences fall out of that, both intended:
 *
 *   - A Greenhouse household ("many homes, many hands") never turns a hand
 *     away: joining it always passes, whatever the joiner already belongs to.
 *   - A Greenhouse member may help at any number of homes, because one of
 *     the homes they hold has no ceiling.
 *
 * A Seedling or Garden user has one home. Creating a second, or accepting an
 * invite to a Seedling / Garden household while already in one, is refused
 * with a 402 that names the cap.
 *
 * Grandfathering is structural, not special-cased: the gate answers "may one
 * more be added?" via `atCap`, so a user who already belongs to five homes
 * keeps all five, can read and act in every one of them, and is only told no
 * when they try for a sixth. Nothing here reads, hides, or removes an
 * existing membership.
 */
import * as householdService from './householdService.js';
import * as billing from './billing.js';
import { atCap, limitOf, strongestPlan, type Limit, type Plan } from '../models/plans.js';

/**
 * Raised when one more household would exceed the user's homes cap.
 * Handlers map it to 402. Checked by `err.name` (not instanceof) like the
 * sibling `PlanLimitError`, so test automocks of this module stay compatible.
 */
export class HomesLimitError extends Error {
  readonly count: number;
  readonly limit: number;
  readonly plan: Plan;
  constructor(count: number, limit: number, plan: Plan) {
    super(`Home limit of ${limit} reached`);
    this.name = 'HomesLimitError';
    this.count = count;
    this.limit = limit;
    this.plan = plan;
  }
}

export interface HomesCheck {
  /** Households the user belongs to right now. */
  count: number;
  /** The cap that applied; `null` is unlimited. */
  limit: Limit;
  /** The strongest plan the user would hold after the action. */
  plan: Plan;
  /** Whether one more household is allowed. */
  allowed: boolean;
}

export interface HomesCheckOptions {
  /** When joining: the household being joined. Its plan counts. */
  joiningHouseholdId?: string;
  /** The joined household's plan id when the caller already read it — saves
   *  a second subscription read of the same row. */
  joiningPlanId?: string;
  /** Caller already fetched the membership list — reuse it rather than re-query. */
  memberships?: ReadonlyArray<{ householdId: string }>;
}

/**
 * Evaluate whether `userId` may belong to one more household. Pure read; the
 * caller decides what to do with the answer.
 */
export async function checkHomesLimit(
  userId: string,
  options: HomesCheckOptions = {}
): Promise<HomesCheck> {
  const memberships = options.memberships ?? (await householdService.getMembershipsByUser(userId));
  const count = memberships.length;

  // The plans the user would hold after the action: every household they are
  // in, plus the one they are joining. Deduplicated so a household is read
  // once even if the caller passes it twice.
  const householdIds = new Set(memberships.map((m) => m.householdId));
  const known = new Map<string, string | undefined>();
  if (options.joiningHouseholdId) {
    householdIds.add(options.joiningHouseholdId);
    if (options.joiningPlanId !== undefined) {
      known.set(options.joiningHouseholdId, options.joiningPlanId);
    }
  }
  const planIds = await Promise.all(
    [...householdIds].map(async (id) =>
      known.has(id) ? known.get(id) : (await billing.getHouseholdSubscription(id)).planId
    )
  );

  const plan = strongestPlan(planIds);
  const limit = limitOf(plan, 'homes');
  return { count, limit, plan, allowed: !atCap(count, limit) };
}

/** `checkHomesLimit`, throwing `HomesLimitError` when the answer is no. */
export async function assertCanAddHome(
  userId: string,
  options: HomesCheckOptions = {}
): Promise<HomesCheck> {
  const check = await checkHomesLimit(userId, options);
  if (!check.allowed) {
    // `allowed` is false only when `atCap` was true, which requires a numeric limit.
    throw new HomesLimitError(check.count, check.limit as number, check.plan);
  }
  return check;
}

/** The 402 body a handler sends for a refused home. One wording, both paths. */
export function homesLimitMessage(err: HomesLimitError): string {
  const homes = err.limit === 1 ? '1 home' : `${err.limit} homes`;
  const belongs = err.count === 1 ? '1 household' : `${err.count} households`;
  return `Your ${err.plan.name} plan includes ${homes} and you already belong to ${belongs}. Upgrade to Greenhouse for unlimited homes.`;
}
