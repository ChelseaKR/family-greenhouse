import type { TaskCompletion, Task } from '@/services/plantService';

/**
 * "Streak" = consecutive completions whose gap to the next-older completion
 * stays within ~1.5x the task's frequency — a regularity measure, not
 * due-date punctuality. It never looks at `nextDue`, so a task completed
 * late every cycle (but at a consistent interval) still keeps its streak.
 *
 * Returns the streak counter (≥0). Caller decides how to render — usually
 * "Karen the Kraken: 4-week watering streak" when streak ≥ 2.
 */
export function computeStreak(task: Task, completions: TaskCompletion[]): number {
  // Only completions for this task, newest first.
  const own = completions
    .filter((c) => c.taskId === task.id)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  if (own.length === 0) return 0;

  // Walk pairs newest→older. A completion is "on time" if the gap to the
  // *next* completion (older) is ≤ frequency * 1.5 days. The 1.5x slack
  // tolerates real life — a one-day delay shouldn't break a streak.
  const frequencyMs = task.frequency * 24 * 60 * 60 * 1000;
  const slack = frequencyMs * 1.5;

  // A streak is only *current* if the newest completion is recent. Without
  // this check a streak that ended months ago still renders as live — the
  // same slack window that links two completions also bounds "still going".
  const newestAt = new Date(own[0].completedAt).getTime();
  if (Date.now() - newestAt > slack) return 0;

  let streak = 1; // we have at least one completion
  for (let i = 0; i < own.length - 1; i++) {
    const newer = new Date(own[i].completedAt).getTime();
    const older = new Date(own[i + 1].completedAt).getTime();
    if (newer - older <= slack) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Walks the entire completion history and returns the longest run of
 * consecutive on-time completions ever observed for this task. Useful
 * for "best streak" stats on the per-plant report — distinct from
 * computeStreak, which only reports the *current* streak.
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

export function streakLabel(task: Task, streak: number): string | null {
  if (streak < 2) return null;
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
  return `${streak}-cycle ${verbBase} streak`;
}
