/**
 * Cross-home Today (ADR 0017): the one cross-household read in the app.
 *
 * Per membership, in parallel: the household row (for its name), the same
 * due/overdue query the dashboard runs (`taskService.getUpcomingTasks` —
 * lifecycle-filtered, vacation-annotated, sorted) filtered to the caller's
 * cutoff, and the membership's own role. Grouped by household, name on
 * every row, never merged.
 *
 * Marginal cost: N of a query the app already runs, once per view, plus a
 * household and a plan read each — about $0.0002 per household per month
 * at DynamoDB on-demand read pricing. No new tables, indexes, or inference.
 *
 * Failure handling is the point of the shape: a household whose read fails
 * is returned as `status: 'unavailable'`, never dropped and never as an
 * empty task list. Absence must not render as a value (ADR 0010).
 */
import * as billing from './billing.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import { getPlan, planIncludesCrossHomeToday } from '../models/plans.js';
import {
  isDueBy,
  type CrossHomeToday,
  type CrossHomeTodayHousehold,
  type CrossHomeTodayRow,
  type HouseholdRole,
} from '../models/crossHomeToday.js';
import { logger } from '../utils/logger.js';

/** The (householdId, role) pair the membership GSI hands back per household. */
export interface Membership {
  householdId: string;
  role: HouseholdRole;
}

/**
 * Whether the caller may see the view, and whether we could even tell.
 *   entitled     — at least one of their households is on a plan that includes it.
 *   locked       — every household's plan was read, and none includes it.
 *   unverifiable — no household grants it AND at least one plan read failed.
 *                  Reported separately (503, not 402) because "we couldn't
 *                  read your plan" must never be shown as "you don't have it".
 */
export type Entitlement = 'entitled' | 'locked' | 'unverifiable';

/**
 * The gate is per USER, resolved across every household they belong to: a
 * subscription belongs to a household, and its members are the "many hands"
 * Greenhouse is sold to. Gating on the active household alone would lock
 * the page the moment a paying member switched to one of their free homes.
 */
export async function resolveEntitlement(memberships: Membership[]): Promise<Entitlement> {
  if (memberships.length === 0) return 'locked';
  const reads = await Promise.allSettled(
    memberships.map((m) => billing.getHouseholdSubscription(m.householdId))
  );
  let unreadable = false;
  for (const [i, read] of reads.entries()) {
    if (read.status === 'rejected') {
      unreadable = true;
      logger.warn(
        { err: read.reason, householdId: memberships[i].householdId },
        'cross_home_today_plan_read_failed'
      );
      continue;
    }
    if (planIncludesCrossHomeToday(getPlan(read.value.planId))) return 'entitled';
  }
  return unreadable ? 'unverifiable' : 'locked';
}

function unavailable(m: Membership, name: string | null): CrossHomeTodayHousehold {
  return { householdId: m.householdId, name, role: m.role, status: 'unavailable' };
}

/**
 * One household's group. Every failure path returns an explicit
 * `unavailable` entry — with the name when the household row was readable
 * and only the tasks were not — so the caller can say WHICH home it could
 * not reach.
 */
async function readHousehold(m: Membership, cutoff: string): Promise<CrossHomeTodayHousehold> {
  const [household, upcoming] = await Promise.allSettled([
    householdService.getHousehold(m.householdId),
    taskService.getUpcomingTasks(m.householdId),
  ]);
  if (household.status === 'rejected') {
    logger.warn(
      { err: household.reason, householdId: m.householdId },
      'cross_home_today_household_unavailable'
    );
    return unavailable(m, null);
  }
  if (household.value === null) {
    // A membership row pointing at a household with no metadata row. Not
    // "no work due" — a home we could not read.
    logger.warn({ householdId: m.householdId }, 'cross_home_today_household_row_missing');
    return unavailable(m, null);
  }
  if (upcoming.status === 'rejected') {
    logger.warn(
      { err: upcoming.reason, householdId: m.householdId },
      'cross_home_today_tasks_unavailable'
    );
    return unavailable(m, household.value.name);
  }
  const householdName = household.value.name;
  const tasks: CrossHomeTodayRow[] = upcoming.value
    .filter((t) => isDueBy(t.nextDue, cutoff))
    .map((t) => ({ ...t, householdName }));
  return { householdId: m.householdId, name: householdName, role: m.role, status: 'ok', tasks };
}

/**
 * Build the queue for the caller's memberships. Every membership yields
 * exactly one entry, in membership order; a throw anywhere inside one
 * household's read becomes that household's `unavailable` entry and never
 * touches the others.
 */
export async function buildCrossHomeToday(
  memberships: Membership[],
  cutoff: string,
  now: Date = new Date()
): Promise<CrossHomeToday> {
  const results = await Promise.allSettled(memberships.map((m) => readHousehold(m, cutoff)));
  const households = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // readHousehold settles its own reads; this is the belt-and-braces path
    // for anything else (a malformed row, a mapping bug) — still an explicit
    // entry, never a hole in the list.
    logger.error(
      { err: r.reason, householdId: memberships[i].householdId },
      'cross_home_today_household_read_threw'
    );
    return unavailable(memberships[i], null);
  });
  return { generatedAt: now.toISOString(), cutoff, households };
}
