/**
 * The one assignment resolver (ADR 0018).
 *
 * Four mechanisms can put a name on a task — manual assignment (incl. a
 * claim), a space's usual caregiver, care rotation, and auto-handoff
 * escalation — and vacation windows re-route whoever ends up holding it. The
 * brief's warning (§4.6) is that the bugs live where those interact, so every
 * caller asks THIS module "who is this task's assignee right now?" instead of
 * re-deriving an answer from the row.
 *
 * Precedence, highest first:
 *
 *   1. EXPLICIT — `assignedTo` set with `assignmentSource: null`. A person
 *      chose (or claimed) this. Rotation and space defaults never touch it;
 *      only escalation may lift it, and only after the household's threshold.
 *   2. ESCALATED — `escalatedForDue === nextDue` and nobody holds it. The
 *      occurrence is up for grabs on purpose; nothing re-assigns it until it
 *      is claimed or completed.
 *   3. INHERITED — `assignmentSource` of `space_default` (this file's rotation
 *      companion adds `rotation` in the same slot). Claimable by anyone.
 *   4. UNASSIGNED — up for grabs.
 *
 * Then, read-time only: an assignee inside an active vacation window with a
 * reachable cover is delivered to that cover (`effectiveUserId`). The row is
 * never rewritten for a vacation — the mapping disappears when the window
 * ends, exactly as `taskService.annotateTasksWithCoverage` already does.
 *
 * Everything here is pure. Callers load the context once per household
 * (members + vacation windows) and resolve any number of tasks against it.
 */
import type { PlantSpace, SpaceRotation, Task } from '../models/types.js';

/** The two member fields resolution needs; `HouseholdMember` satisfies it. */
export interface MemberRef {
  userId: string;
  name: string;
}

/** The vacation fields resolution needs; `taskService.VacationWindow` satisfies it. */
export interface VacationRef {
  userId: string;
  coveredBy: string;
  coveredByName: string | null;
  startDate: string;
  endDate: string;
}

export interface AssignmentContext {
  members: readonly MemberRef[];
  /** Every window that has not ended — active AND upcoming — so a future
   *  occurrence can be checked against a vacation that starts next week. */
  vacations: readonly VacationRef[];
}

export type AssignmentSource =
  'explicit' | 'escalated' | 'rotation' | 'space_default' | 'unassigned';

export interface ResolvedAssignment {
  /** Who holds the task on the row (null = nobody). */
  userId: string | null;
  name: string | null;
  source: AssignmentSource;
  /** Who should actually act right now: the holder, or their cover if away. */
  effectiveUserId: string | null;
  effectiveName: string | null;
  /** Name of the away holder when a cover is standing in; else null. */
  coveringFor: string | null;
}

/** The window that has `userId` away at instant `at`, if any. */
export function vacationAt(
  vacations: readonly VacationRef[],
  userId: string,
  at: Date
): VacationRef | null {
  const atIso = at.toISOString();
  for (const window of vacations) {
    if (window.userId === userId && window.startDate <= atIso && atIso <= window.endDate) {
      return window;
    }
  }
  return null;
}

export function isAwayAt(vacations: readonly VacationRef[], userId: string, at: Date): boolean {
  return vacationAt(vacations, userId, at) !== null;
}

/** A person chose this assignee (manual edit or claim). Never stomped. */
export function isExplicitAssignment(task: Pick<Task, 'assignedTo' | 'assignmentSource'>): boolean {
  return task.assignedTo !== null && task.assignmentSource === null;
}

/** This occurrence was put up for grabs by auto-handoff and nobody has claimed it since. */
export function isEscalatedOccurrence(
  task: Pick<Task, 'assignedTo' | 'nextDue' | 'escalatedForDue'>
): boolean {
  return task.assignedTo === null && task.escalatedForDue === task.nextDue;
}

function memberNamed(members: readonly MemberRef[], userId: string | null): MemberRef | null {
  if (!userId) return null;
  return members.find((member) => member.userId === userId) ?? null;
}

/**
 * Read-time answer for one task. Departed members are treated as nobody:
 * a row pointing at someone who left the household resolves to unassigned
 * rather than to a name no reminder can reach (mirrors `reminders.ts`).
 */
export function resolveAssignment(
  task: Task,
  ctx: AssignmentContext,
  now: Date
): ResolvedAssignment {
  const holder = memberNamed(ctx.members, task.assignedTo);

  let source: AssignmentSource;
  if (holder && task.assignmentSource === null) source = 'explicit';
  else if (holder) source = task.assignmentSource === 'rotation' ? 'rotation' : 'space_default';
  else if (isEscalatedOccurrence(task)) source = 'escalated';
  else source = 'unassigned';

  const base: ResolvedAssignment = {
    userId: holder?.userId ?? null,
    name: holder?.name ?? null,
    source,
    effectiveUserId: holder?.userId ?? null,
    effectiveName: holder?.name ?? null,
    coveringFor: null,
  };
  if (!holder) return base;

  const window = vacationAt(ctx.vacations, holder.userId, now);
  if (!window || window.coveredBy === holder.userId) return base;
  const cover = memberNamed(ctx.members, window.coveredBy);
  // The cover may themselves be away: leave no clear cover rather than point
  // at someone unreachable (same rule as annotateTasksWithCoverage).
  if (!cover || isAwayAt(ctx.vacations, cover.userId, now)) return base;
  return {
    ...base,
    effectiveUserId: cover.userId,
    effectiveName: cover.name,
    coveringFor: holder.name,
  };
}

// ---------------------------------------------------------------------------
// Care rotation (ADR 0018, precedence slot 3)
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which period of the rotation `at` falls in, counted from the anchor.
 *
 * Time-indexed, not a stored counter: a household that skips a cycle, or a
 * task completed late, cannot leave the rotation one step behind reality, and
 * the same answer can be derived for a FUTURE occurrence — which is what
 * "assign next week's turn when next week's task is generated" needs.
 *
 * Monthly counts calendar months (not 30-day blocks) so "Priya has March"
 * means the month, and both ends stay stable across month lengths and DST.
 * Periods before the anchor are negative; the caller's modulo handles that.
 */
export function rotationPeriodIndex(rotation: SpaceRotation, at: Date): number {
  const anchor = new Date(rotation.anchor);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(at.getTime())) return 0;
  if (rotation.cadence === 'monthly') {
    return (
      (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (at.getUTCMonth() - anchor.getUTCMonth())
    );
  }
  return Math.floor((at.getTime() - anchor.getTime()) / WEEK_MS);
}

/**
 * Whose turn it is at `at`, skipping anyone `isEligible` rejects (a member who
 * has left, or is away) by walking forward through the order.
 *
 * Returns null when NOBODY is eligible. That is a real answer — the whole
 * household is away — and the caller must leave the task unassigned (up for
 * grabs) rather than pick someone who cannot act on it. It is never a stand-in
 * for a failed read: callers that could not load members do not call this.
 */
export function rotationTurnAt(
  rotation: SpaceRotation,
  at: Date,
  isEligible: (userId: string) => boolean
): string | null {
  const order = rotation.memberIds;
  if (order.length === 0) return null;
  const period = rotationPeriodIndex(rotation, at);
  const start = ((period % order.length) + order.length) % order.length;
  for (let hop = 0; hop < order.length; hop++) {
    const candidate = order[(start + hop) % order.length];
    if (isEligible(candidate)) return candidate;
  }
  return null;
}

export interface InheritedAssignment {
  userId: string | null;
  name: string | null;
  /** 'rotation' or 'space_default' when someone was inherited; null when nobody
   *  was. A narrow slice of `Task['assignmentSource']`: this resolver never
   *  produces the sources other features write (Seasonal Move Day's
   *  `move_day`), so callers can pass it straight into their own narrower
   *  parameters. */
  source: Extract<Task['assignmentSource'], 'rotation' | 'space_default'> | null;
}

const NOBODY: InheritedAssignment = { userId: null, name: null, source: null };

/**
 * The assignee a NEW occurrence inherits from its space, resolved for the
 * occurrence's own due date. This is the single place rotation and the space
 * default are ranked against each other, and it is deliberately separate from
 * `resolveAssignment`: this one answers "who should this become?" at write
 * time, that one answers "who is it now?" at read time.
 *
 * Explicit assignments never reach here — callers check
 * `isExplicitAssignment` first, which is how a manual assignment or a claim
 * survives every future cycle.
 */
export function resolveInheritedAssignee(
  space: Pick<PlantSpace, 'defaultCaregiverId' | 'rotation'> | null,
  ctx: AssignmentContext,
  dueDate: Date
): InheritedAssignment {
  if (!space) return NOBODY;
  const isMember = (userId: string) => ctx.members.some((m) => m.userId === userId);
  const eligible = (userId: string) =>
    isMember(userId) && !isAwayAt(ctx.vacations, userId, dueDate);

  if (space.rotation && space.rotation.memberIds.length > 0) {
    const turn = rotationTurnAt(space.rotation, dueDate, eligible);
    if (turn) {
      return {
        userId: turn,
        name: memberNamed(ctx.members, turn)?.name ?? null,
        source: 'rotation',
      };
    }
    // A configured rotation with nobody available leaves the task up for
    // grabs. It does NOT fall through to the space default: the household
    // said "these people take turns", and the default caregiver may well be
    // the person who is away.
    return NOBODY;
  }

  const fallback = space.defaultCaregiverId;
  // A departed default caregiver is ignored, exactly as createTask already
  // does — a stale default must never stop care tasks being assignable.
  if (fallback && isMember(fallback)) {
    return {
      userId: fallback,
      name: memberNamed(ctx.members, fallback)?.name ?? null,
      source: 'space_default',
    };
  }
  return NOBODY;
}
