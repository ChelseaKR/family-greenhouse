/**
 * `<input type="date">` (YYYY-MM-DD) → ISO datetime, anchored to the start or
 * end of that day in the browser's LOCAL timezone.
 *
 * The local `Date` constructor interprets year/month/day as wall-clock time
 * here, so `.toISOString()` converts the user's actual local midnight to the
 * right UTC instant. A hardcoded `Z` suffix would instead mean UTC midnight —
 * several hours off for anyone outside that zone, which for a sitter link
 * means a neighbour's access opening (or closing) on the wrong day.
 *
 * Shared by the vacation window form and the sitter-link form so both read
 * a picked date the same way.
 */

export function toStartOfDayIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

export function toEndOfDayIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** Today as YYYY-MM-DD in the local timezone — for a date input's `min`. */
export function todayLocalDateValue(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** What an `<input type="date">` gives us when it holds a real date. */
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

function localDayMs(date: string, endOfDay: boolean): number | null {
  if (!DATE_INPUT.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const parsed = endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whole days of sitter coverage a trip needs, or null when the two dates are
 * not both a real date in order.
 *
 * INCLUSIVE of both ends, and that is the load-bearing part. A window from
 * June 3rd to June 24th runs from local midnight on the 3rd to local
 * 23:59:59.999 on the 24th — 22 days, not 21 — and 22 is the number that
 * matters, because `SitterLinksCard` builds a link as `startsAt + n days`.
 * A link created for 21 days would expire at midnight on the 24th and leave
 * the last day of the trip uncovered. Under-counting here would tell someone
 * their free 7-day link covers a trip it does not.
 *
 * Null is "we cannot say" — a half-filled form — and callers must render it
 * as saying nothing, never as a zero-day trip.
 */
export function tripLengthDays(startDate: string, endDate: string): number | null {
  const start = localDayMs(startDate, false);
  const end = localDayMs(endDate, true);
  if (start === null || end === null || end < start) return null;
  return Math.ceil((end - start) / DAY_MS);
}
