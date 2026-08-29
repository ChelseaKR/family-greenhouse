/**
 * Calendar-date arithmetic in a named IANA zone.
 *
 * A due date in this product is a CALENDAR DAY, not an instant. The task list,
 * the reminder dedupe key and the digest all have to agree on which day a task
 * belongs to, and "elapsed milliseconds divided by 86400000" does not answer
 * that question: it answers "how many 24-hour spans have elapsed", which is a
 * different number whenever the two instants sit on different sides of a local
 * midnight without 24 hours between them.
 *
 * That divergence is #342 item 4. The weekly digest reported
 * `floor(elapsed / 24h)`, so a task due 23:00 and inspected 12 hours later on
 * the following calendar day scored 0 and was described as "ready for a little
 * care today", while the task list next to it said "1 day overdue". The digest
 * under-reported, which is the dangerous direction for a care-reminder
 * product: it reassures exactly the households that need the nudge.
 *
 * Both helpers are DST-safe by construction. They never add or subtract hours;
 * they resolve each instant to its calendar date in the zone and subtract
 * those dates. A day on which the clock jumped is still one day.
 */

/** The calendar date of an instant in `timeZone`, as `YYYY-MM-DD`. */
export function localDateKey(now: Date, timeZone = 'UTC'): string {
  const parts = formatParts(now, timeZone);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatParts(d: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(d);
  } catch {
    // The zone comes from stored user preferences. An unrecognized value must
    // degrade to UTC, not throw inside a scheduled scan.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).formatToParts(d);
  }
}

/**
 * Whole calendar days from `from` to `to` in `timeZone`.
 *
 * Positive when `to` is on a later calendar day than `from`. Same day is 0.
 * This is the backend counterpart of the frontend's `calendarDaysBetween`
 * (`frontend/src/utils/date.ts`), which is what the task list renders, so the
 * two surfaces can finally give the same answer.
 */
export function calendarDaysBetween(from: Date, to: Date, timeZone = 'UTC'): number {
  const a = Date.parse(`${localDateKey(from, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${localDateKey(to, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
