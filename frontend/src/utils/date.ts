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
