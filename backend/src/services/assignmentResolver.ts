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
import type { Task } from '../models/types.js';

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

export type AssignmentSource = 'explicit' | 'escalated' | 'space_default' | 'unassigned';

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
  else if (holder) source = 'space_default';
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
