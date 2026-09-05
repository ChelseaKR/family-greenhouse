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

export function isOverdue(dateString: string): boolean {
  const date = new Date(dateString);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
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

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function toISODateString(date: Date): string {
  return date.toISOString().split('T')[0];
}
