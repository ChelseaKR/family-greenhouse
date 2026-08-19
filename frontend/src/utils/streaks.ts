import { RECENT_COMPLETIONS_LIMIT } from '@/services/plantService';
import type { TaskCompletion, Task } from '@/services/plantService';

/**
 * A current-streak reading, plus whether the list it was counted from could
 * see the whole run.
 *
 * `cycles` is what we counted. `truncated` says that count is a FLOOR: the
 * run reached the oldest completion in a saturated window, so older
 * completions we were never sent may continue it. Render a truncated reading
 * as "N+", never as "N" — see `streakLabel`.
 */
export interface StreakReading {
  /** Consecutive on-time completions counted inside the list we were given. */
  cycles: number;
  /** `cycles` is a lower bound, not a measurement — older care is unseen. */
  truncated: boolean;
}

/**
 * "Streak" = consecutive completions whose gap to the next-older completion
 * stays within ~1.5x the task's frequency — a regularity measure, not
 * due-date punctuality. It never looks at `nextDue`, so a task completed
 * late every cycle (but at a consistent interval) still keeps its streak.
 *
 * WINDOW: its only caller (PlantDetailPage's TaskRow) passes
 * `plant.recentCompletions`, which `GET /plants/{id}` caps at
 * `RECENT_COMPLETIONS_LIMIT` rows across ALL of the plant's tasks — the same
 * cap that made CareReportCard label a ceiling "Total completions" and
 * "Longest streak" (#328). The streak chip consumes that identical array, so
 * it had the identical defect one component over: a plant watered forty
 * consecutive times could render at most "10-cycle watering streak", and far
 * less on a multi-task plant, because water rows share those ten slots with
 * fertilize/prune/repot rows. The chip presented that ceiling as a count.
 *
 * So this returns a `StreakReading` rather than a bare number. When the run
 * consumes every row this task has in a saturated window, nothing here can
 * tell "the streak is exactly N" from "the streak is at least N and the rest
 * is over the horizon", and the reading says so. A true lifetime streak has
 * to be aggregated server-side where the full history lives; it cannot be
 * inferred from this list.
 *
 * `windowLimit` is the size of the window `completions` was drawn from, and
 * exists so tests can exercise saturation without building ten rows.
 */
export function computeStreak(
  task: Task,
  completions: TaskCompletion[],
  windowLimit: number = RECENT_COMPLETIONS_LIMIT
): StreakReading {
  // Only completions for this task, newest first.
  const own = completions
    .filter((c) => c.taskId === task.id)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  if (own.length === 0) return { cycles: 0, truncated: false };

  // Walk pairs newest→older. A completion is "on time" if the gap to the
  // *next* completion (older) is ≤ frequency * 1.5 days. The 1.5x slack
  // tolerates real life — a one-day delay shouldn't break a streak.
  const frequencyMs = task.frequency * 24 * 60 * 60 * 1000;
  const slack = frequencyMs * 1.5;

  // A streak is only *current* if the newest completion is recent. Without
  // this check a streak that ended months ago still renders as live — the
  // same slack window that links two completions also bounds "still going".
  const newestAt = new Date(own[0].completedAt).getTime();
  if (Date.now() - newestAt > slack) return { cycles: 0, truncated: false };

  let streak = 1; // we have at least one completion
  // Stays true only if we walk off the end of `own` without meeting a real
  // gap — i.e. the window, not the user's care, is what ended the run.
  let ranOutOfRows = true;
  for (let i = 0; i < own.length - 1; i++) {
    const newer = new Date(own[i].completedAt).getTime();
    const older = new Date(own[i + 1].completedAt).getTime();
    if (newer - older <= slack) {
      streak += 1;
    } else {
      ranOutOfRows = false;
      break;
    }
  }

  // A window that came back full is a window that was clipped: there is at
  // least one more completion behind it. A short list means the plant really
  // has no more history, so the count there is exact.
  const windowSaturated = completions.length >= windowLimit;
  return { cycles: streak, truncated: ranOutOfRows && windowSaturated };
}

/**
 * Returns the longest run of consecutive on-time completions in the
 * `completions` list it is handed — distinct from computeStreak, which only
 * reports the *current* streak.
 *
 * It is NOT "the best streak ever". Its only caller (CareReportCard) passes
 * `plant.recentCompletions`, which `GET /plants/{id}` caps at
 * RECENT_COMPLETIONS_LIMIT rows across all of the plant's tasks, so the
 * result is bounded by that window. Render it with the window named, or
 * aggregate lifetime streaks server-side where the full history lives.
 */
export function longestStreak(task: Task, completions: TaskCompletion[]): number {
  const own = completions
    .filter((c) => c.taskId === task.id)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  if (own.length === 0) return 0;

  const slack = task.frequency * 24 * 60 * 60 * 1000 * 1.5;
  let best = 1;
  let run = 1;
  for (let i = 0; i < own.length - 1; i++) {
    const newer = new Date(own[i].completedAt).getTime();
    const older = new Date(own[i + 1].completedAt).getTime();
    if (newer - older <= slack) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

/**
 * Renders a reading, or null when there is nothing worth claiming (< 2
 * cycles). A truncated reading is rendered "N+ cycle …" and names the window
 * it could see, because N is a floor: saying "4-cycle watering streak" for a
 * run that is really forty asserts a measurement we do not have. This is the
 * same treatment CareReportCard's labels got in #328.
 */
export function streakLabel(
  task: Task,
  reading: StreakReading,
  windowLimit: number = RECENT_COMPLETIONS_LIMIT
): string | null {
  if (reading.cycles < 2) return null;
  const verbBase =
    task.type === 'water'
      ? 'watering'
      : task.type === 'fertilize'
        ? 'fertilizing'
        : task.type === 'prune'
          ? 'pruning'
          : task.type === 'repot'
            ? 'repotting'
            : (task.customType?.toLowerCase() ?? 'care');
  if (reading.truncated) {
    return `${reading.cycles}+ cycle ${verbBase} streak (within the last ${windowLimit} logged)`;
  }
  return `${reading.cycles}-cycle ${verbBase} streak`;
}
