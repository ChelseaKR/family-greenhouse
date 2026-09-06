/**
 * The window a free-tier analytics request may render (ADR 0014).
 *
 * A calendar year intersected with the trailing `days`. Intersecting — rather
 * than substituting "the last N days" for whatever year was asked for — keeps
 * the answer honest: a past year on a windowed plan comes back empty instead
 * of quietly relabelled. Pure, so the Lambda handler and the local dev server
 * share one definition and the tests can pin a clock.
 *
 * `start` is local midnight `days - 1` days ago, matching
 * `taskService.getDailyCompletionCounts`, so the two endpoints agree on which
 * day is the first one shown.
 */
export function analyticsWindow(
  year: number,
  days: number,
  now: Date = new Date()
): { start: string; end: string } {
  const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00.000Z`);
  const trailingStart = new Date(now);
  trailingStart.setDate(trailingStart.getDate() - days + 1);
  trailingStart.setHours(0, 0, 0, 0);

  const start = new Date(Math.max(yearStart.getTime(), trailingStart.getTime()));
  const end = new Date(Math.min(yearEnd.getTime(), now.getTime()));
  // An empty window (the year ended before the window began) is start == end,
  // which a BETWEEN query answers with nothing.
  if (end.getTime() < start.getTime()) {
    return { start: start.toISOString(), end: start.toISOString() };
  }
  return { start: start.toISOString(), end: end.toISOString() };
}
