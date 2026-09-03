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
