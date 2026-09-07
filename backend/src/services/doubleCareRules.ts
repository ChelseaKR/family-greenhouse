/**
 * Double-care detection + schedule-drift arithmetic — the PURE half of the
 * household toolkit's completion-log features (brief §4.7 and its
 * "Extension"). No AWS imports on purpose: `local-server.ts` shares this
 * module, so the mock dev server and the Lambda cannot disagree on a window,
 * a threshold, or a median. The DynamoDB reads live in `doubleCare.ts`.
 *
 * Marginal cost per household per month: $0. Everything here is arithmetic
 * over rows the completion log already writes.
 */

export const DEFAULT_DOUBLE_CARE_WINDOW_HOURS = 24;

/**
 * How long after one member's completion a second member's completion of the
 * same task — or the same plant + same care type — counts as "already done".
 * Server-side by design: the client only ever renders what the server
 * decided. Watering is the case the brief names (24h). Slower-cadence care
 * gets a longer window because two people fertilizing the same plant three
 * days apart is the same household event as two waterings in a day.
 */
export const DOUBLE_CARE_WINDOW_HOURS: Readonly<Record<string, number>> = {
  water: 24,
  fertilize: 72,
  prune: 72,
  repot: 24 * 14,
};

/** Detection window for a care type; unknown/custom types get the default. */
export function doubleCareWindowHours(taskType: string): number {
  return DOUBLE_CARE_WINDOW_HOURS[taskType] ?? DEFAULT_DOUBLE_CARE_WINDOW_HOURS;
}

/** ISO instant at which the detection window for `taskType` opens. */
export function doubleCareWindowStart(taskType: string, now: Date): string {
  return new Date(now.getTime() - doubleCareWindowHours(taskType) * 3_600_000).toISOString();
}

/** The completion-log fields the detector and the drift math read. */
export interface CompletionLike {
  id: string;
  taskId: string;
  taskType: string;
  completedBy: string;
  completedByName: string;
  completedAt: string;
  /** Set on a completion the member explicitly logged as a duplicate. */
  duplicateOfCompletionId?: string | null;
}

export interface RecentDuplicate {
  completionId: string;
  completedAt: string;
  completedBy: string;
  completedByName: string;
  taskId: string;
  taskType: string;
  /** true = the very same task; false = same plant + same care type, another task. */
  sameTask: boolean;
  windowHours: number;
}

/**
 * The most recent completion by ANOTHER actor inside the window that matches
 * the completion being attempted — by task id, or by care type on the same
 * plant (callers hand in one plant's completions). `completions` may be in any
 * order. Returns null when there is no such completion.
 *
 * The same actor is excluded on purpose: one person double-tapping is what
 * the `expectedNextDue` occurrence token already handles, and it is not a
 * household coordination event.
 */
export function pickRecentDuplicate(
  completions: readonly CompletionLike[],
  target: { taskId: string; taskType: string; actorId: string; now: Date }
): RecentDuplicate | null {
  const windowHours = doubleCareWindowHours(target.taskType);
  const sinceMs = target.now.getTime() - windowHours * 3_600_000;
  let best: CompletionLike | null = null;
  let bestAt = -Infinity;
  for (const completion of completions) {
    if (completion.completedBy === target.actorId) continue;
    const at = Date.parse(completion.completedAt);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const sameTask = completion.taskId === target.taskId;
    if (!sameTask && completion.taskType !== target.taskType) continue;
    if (at > bestAt) {
      best = completion;
      bestAt = at;
    }
  }
  if (!best) return null;
  return {
    completionId: best.id,
    completedAt: best.completedAt,
    completedBy: best.completedBy,
    completedByName: best.completedByName,
    taskId: best.taskId,
    taskType: best.taskType,
    sameTask: best.taskId === target.taskId,
    windowHours,
  };
}

// ---------------------------------------------------------------- drift

/** Fewer completions than this and no drift is computed — the payload says so. */
export const DRIFT_MIN_COMPLETIONS = 4;
/** |median − scheduled| / scheduled above this earns a suggestion. */
export const DRIFT_THRESHOLD = 0.3;
/** Only the most recent N completions count: a rhythm is recent behaviour. */
export const DRIFT_MAX_COMPLETIONS = 12;

export interface ScheduleDriftReading {
  /** Median actual interval between consecutive completions, one decimal. */
  medianIntervalDays: number;
  /** Signed fraction: +0.57 = done 57% less often than scheduled. */
  driftPct: number;
  /** Whole-day frequency that matches the median. */
  suggestedFrequency: number;
  /** True only when the drift exceeds the threshold AND changes the frequency. */
  exceedsThreshold: boolean;
}

export type ScheduleDriftReason =
  | 'insufficient_completions'
  /** The completion history could not be read. */
  | 'history_unavailable'
  /**
   * The history read fine, but the interval to measure it AGAINST could not be
   * established: the task carries a seasonal profile
   * (services/seasonalCadence.ts) and the household row — which supplies the
   * hemisphere the season is derived from — could not be read.
   *
   * A distinct reason rather than reuse of `history_unavailable`, and rather
   * than quietly measuring against the task's base `frequency`. Drift is
   * `(median − scheduled) / scheduled`: measuring against the wrong
   * `scheduled` does not produce a slightly-off number, it produces a
   * confident wrong one, on a payload that publishes
   * `scheduledIntervalDays` as if it were the interval in force.
   */
  | 'schedule_unavailable';

/**
 * Per-task drift payload. `drift` is null in exactly two cases, and `reason`
 * names which: not enough history to say, or the history read failed. A null
 * is never a "0% drift" in disguise — that is this repo's named defect class.
 */
export interface ScheduleDrift {
  taskId: string;
  scheduledIntervalDays: number;
  completionsConsidered: number;
  requiredCompletions: number;
  drift: ScheduleDriftReading | null;
  reason: ScheduleDriftReason | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Drift of a task's real rhythm from its schedule, from its completion log.
 * Confirmed duplicates are excluded: a second watering four hours after the
 * first is a coordination slip, not the household's watering interval.
 */
export function computeScheduleDrift(
  taskId: string,
  scheduledIntervalDays: number,
  completions: readonly Pick<CompletionLike, 'completedAt' | 'duplicateOfCompletionId'>[]
): ScheduleDrift {
  const instants = completions
    .filter((c) => !c.duplicateOfCompletionId)
    .map((c) => Date.parse(c.completedAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b)
    .slice(-DRIFT_MAX_COMPLETIONS);

  const base = {
    taskId,
    scheduledIntervalDays,
    completionsConsidered: instants.length,
    requiredCompletions: DRIFT_MIN_COMPLETIONS,
  };

  if (instants.length < DRIFT_MIN_COMPLETIONS || scheduledIntervalDays <= 0) {
    return { ...base, drift: null, reason: 'insufficient_completions' };
  }

  const intervalsDays: number[] = [];
  for (let i = 1; i < instants.length; i++) {
    intervalsDays.push((instants[i] - instants[i - 1]) / 86_400_000);
  }
  const medianDays = median(intervalsDays);
  const driftPct = (medianDays - scheduledIntervalDays) / scheduledIntervalDays;
  const suggestedFrequency = Math.max(1, Math.round(medianDays));
  const exceedsThreshold =
    Math.abs(driftPct) > DRIFT_THRESHOLD && suggestedFrequency !== scheduledIntervalDays;

  return {
    ...base,
    drift: {
      medianIntervalDays: Math.round(medianDays * 10) / 10,
      driftPct: Math.round(driftPct * 1000) / 1000,
      suggestedFrequency,
      exceedsThreshold,
    },
    reason: null,
  };
}

/** The explicit "we could not read the history" payload for one task. */
export function scheduleDriftUnavailable(
  taskId: string,
  scheduledIntervalDays: number
): ScheduleDrift {
  return {
    taskId,
    scheduledIntervalDays,
    completionsConsidered: 0,
    requiredCompletions: DRIFT_MIN_COMPLETIONS,
    drift: null,
    reason: 'history_unavailable',
  };
}

/**
 * The explicit "we could not establish this task's scheduled interval" payload
 * — see `ScheduleDriftReason.schedule_unavailable`.
 *
 * `scheduledIntervalDays` carries the task's base frequency because the field
 * is required and that is the only interval actually known; `drift` is null
 * and `reason` says why, so no caller can read the pair as a measurement.
 */
export function scheduleDriftScheduleUnavailable(
  taskId: string,
  baseFrequency: number
): ScheduleDrift {
  return {
    taskId,
    scheduledIntervalDays: baseFrequency,
    completionsConsidered: 0,
    requiredCompletions: DRIFT_MIN_COMPLETIONS,
    drift: null,
    reason: 'schedule_unavailable',
  };
}

/**
 * Next due date after matching the schedule to reality: the last completion
 * plus the new interval, floored at `now` so the tap never produces an
 * instantly-overdue task (by the household's own rhythm it is due, not late).
 * UTC date arithmetic, the same as `completeTask` under the Lambdas' TZ=UTC —
 * which since #590 is a setting (`TZ = "UTC"` on `local.lambda_environment` in
 * `infrastructure/modules/api/main.tf`) rather than an inherited AWS default.
 */
export function nextDueAfterMatch(
  lastCompleted: string | null,
  newFrequencyDays: number,
  now: Date
): string | null {
  if (!lastCompleted) return null;
  const base = new Date(lastCompleted);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + newFrequencyDays);
  return new Date(Math.max(base.getTime(), now.getTime())).toISOString();
}
