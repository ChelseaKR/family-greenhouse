/**
 * Cross-home Today — the shared, dependency-free vocabulary for
 * `GET /me/today` (ADR 0017). The Lambda service
 * (`services/crossHomeToday.ts`) and the mock dev server (`local-server.ts`)
 * both build their responses from these types and this cutoff rule, so the
 * two cannot drift on what "today" means or on what an unavailable home
 * looks like.
 *
 * The view is a WORK QUEUE, not an inventory: what is due today or already
 * overdue in each household the caller belongs to, grouped by household with
 * the household's name on every row. It is never a merged plant list — the
 * "no global view" rule in docs/multi-household.md is about mixing
 * inventories on one screen, and it still stands.
 */
import type { TaskWithCoverage } from '../services/taskService.js';

export type HouseholdRole = 'admin' | 'member';

/** One row of the queue: a household's task, labelled with its home. */
export interface CrossHomeTodayRow extends TaskWithCoverage {
  /**
   * The home this row belongs to — on EVERY row, so a row is self-describing
   * even when it is rendered away from its group.
   */
  householdName: string;
}

/**
 * A household that answered: the caller's role there (from its membership
 * row, never from a claim) and its due/overdue rows — possibly none, which
 * is a genuine "nothing due here", distinct from `unavailable` below.
 */
export interface CrossHomeTodayHouseholdOk {
  householdId: string;
  name: string;
  role: HouseholdRole;
  status: 'ok';
  tasks: CrossHomeTodayRow[];
}

/**
 * A household whose read failed. Returned explicitly, never dropped and
 * never as an empty task list: a missing group would read as "nothing due
 * there" (ADR 0010). `name` is null when the household row itself could not
 * be read.
 */
export interface CrossHomeTodayHouseholdUnavailable {
  householdId: string;
  name: string | null;
  role: HouseholdRole;
  status: 'unavailable';
}

export type CrossHomeTodayHousehold =
  CrossHomeTodayHouseholdOk | CrossHomeTodayHouseholdUnavailable;

export interface CrossHomeToday {
  generatedAt: string;
  /** The instant "today" ends for this response — everything due at or before it is in. */
  cutoff: string;
  /** One entry per membership, in membership order. Never a flat task list. */
  households: CrossHomeTodayHousehold[];
}

/**
 * How far from the server's "now" a client-supplied cutoff may sit. Every
 * wall-clock "end of today" on Earth is within ±26h of UTC now; 48h leaves
 * room for clock skew while keeping the parameter unable to describe
 * anything other than today.
 */
export const UNTIL_WINDOW_MS = 48 * 60 * 60 * 1000;

export class InvalidUntilError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUntilError';
  }
}

/**
 * Resolve the cutoff instant. The server has no idea when the caller's day
 * ends, so the client sends its local end-of-day as `until`; absent that,
 * the end of the UTC day. Bounded to ±48h of now so the parameter is
 * "today" and nothing else. Throws InvalidUntilError (→ 400) on garbage or
 * an out-of-window value.
 */
export function resolveCutoff(until: string | undefined, now: Date = new Date()): string {
  if (until === undefined || until === '') {
    const end = new Date(now);
    end.setUTCHours(23, 59, 59, 999);
    return end.toISOString();
  }
  const parsed = new Date(until);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidUntilError('until must be an ISO-8601 date-time');
  }
  if (Math.abs(parsed.getTime() - now.getTime()) > UNTIL_WINDOW_MS) {
    throw new InvalidUntilError('until must be within 48 hours of now');
  }
  return parsed.toISOString();
}

/**
 * True when a task's next due instant is at or before the cutoff. Compares
 * instants, not ISO strings, so a differently-formatted but equal timestamp
 * cannot sort itself out of today.
 */
export function isDueBy(nextDue: string, cutoffIso: string): boolean {
  return new Date(nextDue).getTime() <= new Date(cutoffIso).getTime();
}

/** 402 body when no household of the caller's is on a plan that includes the view. */
export const CROSS_HOME_TODAY_LOCKED_MESSAGE =
  'Today across your homes is included with the Greenhouse plan. Upgrade any one of your households to Greenhouse to see every home in one list.';

/** 503 body when entitlement could not be read — "we couldn't check" is not "you don't have it". */
export const CROSS_HOME_TODAY_UNVERIFIABLE_MESSAGE =
  "We couldn't confirm your plan just now, so this page can't be shown. Please try again in a moment.";
