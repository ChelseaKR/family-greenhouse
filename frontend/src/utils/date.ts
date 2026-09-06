/**
 * Calendar-day difference `to - from`, immune to DST. Subtracting local
 * midnights gives 23h/25h days across DST transitions, and Math.ceil over
 * a 25h gap reports "2 days" for yesterday. Instead we re-anchor both
 * local calendar dates at UTC noon, where every day is exactly 24h.
 * Positive = `to` is after `from`; negative = before.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate(), 12);
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate(), 12);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * The instant a task created *right now* first falls due: the END of the
 * creator's local calendar day, never the creation instant.
 *
 * `createTask` on the backend defaults `nextDue` to `now` when the caller
 * sends none, and its overdue predicate is a plain instant comparison
 * (`t.nextDue < now`). Those two together meant every task created in the app
 * was overdue one second after it was created: the sitter view showed a red
 * "overdue" badge on a plant added a minute ago, `GET /tasks?overdue=true`
 * counted it, and the weekly digest mailed it as a plant at risk — while this
 * file's own `isToday`/`formatDueDate` said "Today", because they compare
 * calendar days, not instants (#346).
 *
 * "First occurrence is today" is the product intent, so the honest encoding of
 * it is the last instant of today rather than this one. The browser is the
 * only party that knows the creator's zone — the household has no stored zone
 * yet (#342) — so the client sends the value and the server stores it.
 *
 * DST-safe: `setHours` is wall-clock, so a 23- or 25-hour day still ends at
 * local 23:59:59.999.
 */
export function firstDueIso(now: Date = new Date()): string {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay.toISOString();
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';

  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString);
  const diff = calendarDaysBetween(new Date(), date);

  if (diff < 0) {
    if (diff === -1) return 'Yesterday';
    return `${-diff} days ago`;
  }
  if (diff === 0) {
    return 'Today';
  }
  if (diff === 1) {
    return 'Tomorrow';
  }

  if (diff <= 7) {
    return date.toLocaleDateString(undefined, { weekday: 'long' });
  }

  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Is this due date behind the *calendar day* we are in? A household's "today"
 * is a day, not an instant: a task due at 09:00 is still today's job at 17:00,
 * which is why `firstDueIso` above puts a task created today at the END of
 * today (#346, #539).
 *
 * `now` is injectable so callers that already read the clock — and schedulers
 * that must ask "is it overdue *at this instant*" — classify against one
 * reading instead of racing their own.
 */
export function isOverdue(dateString: string, now: Date = new Date()): boolean {
  const date = new Date(dateString);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

/**
 * The instant `isOverdue(dateString)` first turns true: local midnight at the
 * start of the day AFTER the due date's local calendar day.
 *
 * For anything that wakes up to announce an overdue task. Waking at the due
 * *instant* instead fires while every surface in the app still labels the task
 * "Today" — the notification and the red state were never true at the same
 * time (#591). `isOverdue(d, now) === overdueAt(d) <= now.getTime()` by
 * construction, and a test pins that; whoever changes one must change both.
 *
 * DST-safe: `setHours`/`setDate` are wall-clock, so a 23- or 25-hour day still
 * ends at the next local midnight.
 */
export function overdueAt(dateString: string): number {
  const startOfNextDay = new Date(dateString);
  startOfNextDay.setHours(0, 0, 0, 0);
  startOfNextDay.setDate(startOfNextDay.getDate() + 1);
  return startOfNextDay.getTime();
}

/**
 * Short due-date label for task rows: "Overdue" / "Today" / "Tomorrow",
 * else a weekday+date. Calendar-day comparison (local midnight) so it stays
 * consistent with `isOverdue`/`isToday` above.
 */
export function formatDueDate(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  today.setHours(0, 0, 0, 0);
  tomorrow.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);

  if (date.getTime() < today.getTime()) {
    return 'Overdue';
  }
  if (date.getTime() === today.getTime()) {
    return 'Today';
  }
  if (date.getTime() === tomorrow.getTime()) {
    return 'Tomorrow';
  }
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function isToday(dateString: string): boolean {
  const date = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() === today.getTime();
}

/*
 * `addDays` and `toISODateString` used to live here. Both were exported, both
 * were tested, and neither was called from anywhere in the application (#342,
 * closing note). They are gone rather than kept "in case", because the second
 * one was a trap for whoever called it first:
 *
 *   toISODateString(date) => date.toISOString().split('T')[0]
 *
 * `toISOString()` is UTC. Every other helper in this file reads a `Date` in
 * the BROWSER's zone — `isToday`, `isOverdue` and `calendarDaysBetween` all
 * use `getFullYear`/`getMonth`/`getDate`. So a caller mixing them got the
 * local day from one and the UTC day from the other, and they disagree for
 * part of every day: at 23:00 on 15 April in New York the helper returned
 * `2024-04-16`. Its one test passed `2024-04-15T12:00:00Z` — noon UTC, the
 * one value in the day that cannot expose it. That is the same shape as the
 * ICS test #342 §3 calls out, and the same shape as a gate that cannot fail.
 *
 * Nothing zone-aware replaces them here on purpose. ADR 0025 §6 phase 6 is
 * where `utils/date.ts` and its two copy-pasted duplicates in `TasksPage` and
 * `AnalyticsPage` collapse onto the household's zone; a day helper written
 * before that decision would be a third answer to the question phase 6 exists
 * to settle. Anything needing "the calendar day of this instant" should wait
 * for it, or state the zone it means at the call site.
 */
