import type { ActivityEvent, HouseholdMember } from '@/services/householdService';
import type { TaskWithCoverage } from '@/services/taskService';

/**
 * "Who is carrying the care" — derived entirely from data every member can
 * already see (the household activity feed and the shared task list), so this
 * widens nobody's visibility. It only stops each person having to scroll the
 * feed and keep a private tally in their head, which is where the nagging
 * starts.
 *
 * Two numbers per person, deliberately:
 *   - `completed` — care actually done in the covered period (the past).
 *   - `holding`   — active tasks whose effective assignee they are (the
 *     future). Effective, not raw, so a vacation hand-off shows the person
 *     genuinely covering rather than the one who is away.
 *
 * A third bucket, `upForGrabs`, counts the unassigned tasks. It is the answer
 * to a lopsided split, which is why it is reported alongside rather than
 * dropped: the fix for "it all lands on one person" is a pool anyone can pull
 * from, not a reminder aimed at somebody.
 */

export const CARE_LOAD_WINDOW_DAYS = 30;

/** Activity actor id prefix the sitter-completion path writes (`sitter:{linkId}`). */
const SITTER_ACTOR_PREFIX = 'sitter:';

/** Aggregate key for every sitter completion, whichever link it came through. */
export const SITTER_ENTRY_KEY = 'sitter';

/** Activity actor id prefix the kiosk-completion path writes (`kiosk:{linkId}`). */
const KIOSK_ACTOR_PREFIX = 'kiosk:';

/** Aggregate key for every wall-display completion. Its own row rather than a
 *  'past' member: the kiosk is a surface, not a person who left, and labelling
 *  it "Former member" would state something untrue on a shared screen. */
export const KIOSK_ENTRY_KEY = 'kiosk';

/**
 * Below this many completions a "share" is noise — three tasks in a month is
 * not evidence about how a household divides its work.
 */
const LEAD_CARRIER_MIN_COMPLETIONS = 5;

/** A share at or above this reads as "most of it landed on one person". */
const LEAD_CARRIER_SHARE = 0.6;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CareLoadKind = 'member' | 'sitter' | 'kiosk' | 'past';

export interface CareLoadEntry {
  /** userId for a member, `SITTER_ENTRY_KEY` for the pooled sitter row,
   *  `KIOSK_ENTRY_KEY` for the pooled wall-display row. */
  key: string;
  /** Display name. Empty for the sitter and kiosk rows — the UI labels those. */
  name: string;
  kind: CareLoadKind;
  /** Care completions recorded inside the covered period. */
  completed: number;
  /** Share of the period's completions, 0–1. Zero when nothing was logged. */
  share: number;
  /** Active tasks this person is the effective assignee of, right now. */
  holding: number;
}

export interface CareLoadSummary {
  entries: CareLoadEntry[];
  totalCompleted: number;
  /** Active tasks with no assignee — the pool anyone can pick up. */
  upForGrabs: number;
  /** Start of the period the counts actually cover (ISO). */
  periodStart: string;
  /**
   * True when the activity feed hit its page limit before reaching the far
   * end of the requested window. The counts are then a partial view of the
   * period, so the UI must say "since {periodStart}" rather than claim the
   * full 30 days — a share computed over a truncated feed is exactly the kind
   * of confident-but-wrong number this codebase refuses to print.
   */
  capped: boolean;
  /** The member carrying most of the load, when the split is lopsided. */
  leadCarrier: CareLoadEntry | null;
}

export interface CareLoadInputs {
  members: HouseholdMember[];
  activity: ActivityEvent[];
  /** The `limit` the activity feed was requested with — used to detect a cap. */
  activityLimit: number;
  tasks: TaskWithCoverage[];
  now?: number;
  windowDays?: number;
}

const KIND_ORDER: Record<CareLoadKind, number> = { member: 0, sitter: 1, kiosk: 2, past: 3 };

export function buildCareLoad({
  members,
  activity,
  activityLimit,
  tasks,
  now = Date.now(),
  windowDays = CARE_LOAD_WINDOW_DAYS,
}: CareLoadInputs): CareLoadSummary {
  const requestedStart = now - windowDays * DAY_MS;

  // The feed arrives newest-first, but derive the horizon from the values
  // rather than trusting the order.
  let oldestSeen = Number.POSITIVE_INFINITY;
  for (const event of activity) {
    const at = Date.parse(event.occurredAt);
    if (Number.isFinite(at) && at < oldestSeen) oldestSeen = at;
  }
  const capped =
    activity.length >= activityLimit && Number.isFinite(oldestSeen) && oldestSeen > requestedStart;
  const periodStartMs = capped ? oldestSeen : requestedStart;

  const tallies = new Map<string, { name: string; kind: CareLoadKind; completed: number }>();
  for (const member of members) {
    tallies.set(member.userId, { name: member.name, kind: 'member', completed: 0 });
  }

  let totalCompleted = 0;
  for (const event of activity) {
    if (event.type !== 'task.completed') continue;
    const at = Date.parse(event.occurredAt);
    if (!Number.isFinite(at) || at < periodStartMs) continue;

    const viaSitter = event.actorId.startsWith(SITTER_ACTOR_PREFIX);
    const viaKiosk = event.actorId.startsWith(KIOSK_ACTOR_PREFIX);
    // Every sitter link collapses into one row, and so does the wall display:
    // which link a completion came through is management detail, and pooling
    // keeps link ids off the page.
    const key = viaSitter ? SITTER_ENTRY_KEY : viaKiosk ? KIOSK_ENTRY_KEY : event.actorId;
    const tally = tallies.get(key);
    if (tally) {
      tally.completed += 1;
    } else {
      // An actor who is not a current member and not one of the token-scoped
      // surfaces: someone who has since left. The activity feed already shows
      // their name against these same events, so naming them here exposes
      // nothing new — and dropping them would make the remaining shares add
      // up to more than the household actually did.
      tallies.set(key, {
        name: viaSitter || viaKiosk ? '' : event.actorName,
        kind: viaSitter ? 'sitter' : viaKiosk ? 'kiosk' : 'past',
        completed: 1,
      });
    }
    totalCompleted += 1;
  }

  const holding = new Map<string, number>();
  let upForGrabs = 0;
  for (const task of tasks) {
    const assignee = task.effectiveAssignee ?? task.assignedTo;
    if (!assignee) {
      upForGrabs += 1;
      continue;
    }
    holding.set(assignee, (holding.get(assignee) ?? 0) + 1);
    if (!tallies.has(assignee)) {
      // A standing assignment left behind by someone who has left the
      // household. Surfacing it is the point: those tasks are nobody's in
      // practice, and they are invisible in every member's "assigned to me".
      tallies.set(assignee, {
        name: task.effectiveAssigneeName ?? task.assignedToName ?? '',
        kind: 'past',
        completed: 0,
      });
    }
  }

  const entries: CareLoadEntry[] = [...tallies.entries()]
    .map(([key, tally]) => ({
      key,
      name: tally.name,
      kind: tally.kind,
      completed: tally.completed,
      share: totalCompleted > 0 ? tally.completed / totalCompleted : 0,
      holding: holding.get(key) ?? 0,
    }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        b.completed - a.completed ||
        b.holding - a.holding ||
        a.name.localeCompare(b.name)
    );

  const memberEntries = entries.filter((entry) => entry.kind === 'member');
  const top = memberEntries[0];
  const leadCarrier =
    memberEntries.length >= 2 &&
    totalCompleted >= LEAD_CARRIER_MIN_COMPLETIONS &&
    top &&
    top.share >= LEAD_CARRIER_SHARE
      ? top
      : null;

  return {
    entries,
    totalCompleted,
    upForGrabs,
    periodStart: new Date(periodStartMs).toISOString(),
    capped,
    leadCarrier,
  };
}
