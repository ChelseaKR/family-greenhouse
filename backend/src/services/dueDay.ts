/**
 * "Which day is this task for?" — the one place that answers it.
 *
 * [ADR 0025](../../../docs/adr/0025-household-timezone-and-the-due-date-migration.md)
 * phase 3. Phase 1 stored the household zone and read it nowhere; this module
 * is the shared `localDay` helper that phase 4's cutover will call, landed
 * ahead of the cutover so the cutover is a call-site swap rather than nine
 * simultaneous rewrites of the same arithmetic.
 *
 * ## Nothing in production calls this yet, and that is the point
 *
 * Every due-date answer the product gives is still computed inline at its own
 * call site, exactly as it was before this file existed. `taskService` writes
 * `t.nextDue < nowIso`; `escalationRule.daysOverdue` and
 * `digestReport.wholeDaysOverdue` each write `floor((now - due) / 24h)`;
 * `reminders.dueStateFor` writes a third variant that buckets the same
 * subtraction into upcoming/today/overdue. Four expressions, one question,
 * and #342 is the list of ways they disagree with each other and with the
 * browser.
 *
 * Phase 4 replaces those four expressions with calls to this module. It is a
 * cutover — it reclassifies live households' tasks — and ADR 0025 §6 gives it
 * a named date, a household to go first, and someone watching the support
 * inbox. None of that is here.
 *
 * ## Why an unused module is nevertheless exercised
 *
 * ADR 0025's consequences section names the honest cost of phase 1: "a field
 * nobody reads is a field that can rot." The same cost applies to a helper
 * nobody calls, and the mitigation is in `dueDay.test.ts`: the equivalence
 * suite runs this module and the four production expressions over the same
 * table of instants and asserts they agree **for a household with no zone
 * set**. That is the load-bearing claim of the whole migration — ADR 0025 §2,
 * "a household with no zone set keeps today's behaviour, exactly" — and it is
 * the one claim that can be tested before the cutover rather than after it.
 *
 * If someone changes one of those four expressions, the equivalence test goes
 * red and this module has to move with it. That is the intended coupling: it
 * is what stops the helper drifting away from the code it is meant to replace
 * during however long phase 4 waits for its named date.
 *
 * ## The two rules
 *
 * `householdTimeZone` is the household's stored IANA zone, normalised through
 * `householdTimeZone.ts`. It selects the rule, and the selection is the whole
 * migration:
 *
 *   - **unset (`''`)** — the INSTANT rule. Today's behaviour, byte for byte.
 *     A task is overdue the moment its `nextDue` instant passes, wherever the
 *     reader happens to be. Every household in production is here.
 *   - **any valid zone, `'UTC'` included** — the CALENDAR-DAY rule. A task is
 *     overdue once the household's local day has moved past the local day its
 *     `nextDue` instant falls on.
 *
 * `'UTC'` deliberately takes the calendar-day path even though its offset is
 * zero: a household that chose UTC asked for the new rule, and one that was
 * never asked did not. Collapsing the two would make the cutover unobservable,
 * which is why `normalizeHouseholdTimeZone` keeps them apart.
 *
 * ## Direction of travel — and three places ADR 0025 §4 overstates it
 *
 * The guarantee the cutover is sold on holds for the OVERDUE THRESHOLD, and
 * the test file proves it over every pair in its fixture table in four zones:
 * the threshold moves from the `nextDue` instant to the END of that instant's
 * local day, `nextDue` always falls inside its own local day, so the threshold
 * is always later or equal. Nothing becomes overdue earlier than it does now.
 *
 * §4 states that guarantee more broadly than it holds, and phase 3 exists to
 * find that out before the cutover rather than after it. Three measured
 * corrections, each pinned by a named test:
 *
 *   1. **`due today → overdue` DOES happen** for `reminders.dueStateFor`'s day
 *      buckets, because its `today` means "overdue by under 24 elapsed hours",
 *      not "due on today's date". A task whose local day has turned inside the
 *      last 24 hours is `today` now and `overdue, days: 1` after. Live
 *      consequence: `escalationCandidates` and `isRestingOverdue` both compare
 *      a day count against a threshold, so auto-handoff and the 14-day
 *      reminder decay can fire a day earlier.
 *   2. **`upcoming → due` DOES move earlier.** A calendar-day rule makes a
 *      task due from local midnight, necessarily before an instant later that
 *      day. This is inherent to the target model rather than a defect in it —
 *      and it is arguably what #343 is asking for.
 *   3. **The day count moves DOWN as well as up.** §3 anticipates only the
 *      upward move. For a `now` late in a local day behind UTC, elapsed hours
 *      have crossed one more 24-hour boundary than the calendar has crossed
 *      midnights, and the count drops by one.
 *
 * All three are bounded at one day. None of them changes anything for a
 * household with no zone set, which is every household today.
 *
 * ## What this module deliberately does not do
 *
 * - **It does not touch stored values.** `nextDue` keeps its type and its
 *   value; only the comparison changes (ADR 0025 §1). Rewriting it would
 *   unpin `escalatedForDue` / `helpAskedForDue` and every optimistic
 *   `ConditionExpression` that compares against the exact string.
 * - **It does not normalise the instant** — no anchoring to local noon. ADR
 *   0025 §5 lists that as needing its own ADR and its own reversal plan.
 *   `nextDue` in, calendar day out.
 * - **It does not decide the reminder SEND time.** That is #343, which ADR
 *   0025 says stays open because "when to send" only becomes answerable once
 *   "which day is this for" has an answer. This module is the answer to the
 *   second question and takes no position on the first.
 * - **It does not model month-end.** "Monthly" is `frequencyDays: 30`, so a
 *   monthly task walks about five days a year. A calendar-day due date does
 *   not fix a day-count recurrence (ADR 0025, closing consequence).
 */
import { HOUSEHOLD_TIMEZONE_UNSET, normalizeHouseholdTimeZone } from './householdTimeZone.js';

export { HOUSEHOLD_TIMEZONE_UNSET };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which comparison a household gets. Chosen by whether it has set a zone. */
export type DueRule = 'instant' | 'calendar-day';

/**
 * The rule this household is on.
 *
 * Takes the RAW stored value rather than a pre-normalised one, so a caller
 * cannot accidentally hand it a `'UTC'` it produced itself as a default. A
 * zone that is absent, empty, the wrong type, or no longer in the runtime's tz
 * database all read as unset — the conservative direction, because unset means
 * "keep today's behaviour" rather than "assert a zone nobody picked".
 */
export function dueRuleFor(householdTimeZone: unknown): DueRule {
  return normalizeHouseholdTimeZone(householdTimeZone) === HOUSEHOLD_TIMEZONE_UNSET
    ? 'instant'
    : 'calendar-day';
}

/**
 * The calendar day an instant falls on, in `timeZone`, as `YYYY-MM-DD`.
 *
 * `en-CA` because its short date format is ISO-ordered, so the parts come back
 * in the order they are wanted; the parts are read by type rather than by
 * position so a locale-data change cannot silently reorder them.
 *
 * Returns `null` for an unparseable instant. A due date we cannot read is not
 * a day — `null` propagates as `unknown` through `dueStateFor` below rather
 * than being rounded to today, which is ADR 0010's rule and the defect class
 * (#339/#341) this repository keeps unwinding.
 */
export function localDay(instant: Date | string | number, timeZone: string): string | null {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(String(instant));
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const [year, month, day] = [part('year'), part('month'), part('day')];
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Whole days from one `YYYY-MM-DD` to another, counting calendar days rather
 * than elapsed hours.
 *
 * Both are read as UTC midnights, which is legitimate precisely because they
 * are already day labels with no time and no zone left in them: the zone was
 * spent in `localDay`. Interpreting two day labels in the same arbitrary zone
 * and subtracting gives the number of midnights between them, which is what a
 * calendar-day count means, and it is why a DST day counts as one day here
 * even though it is 23 or 25 hours long.
 */
export function calendarDaysBetween(fromDay: string, toDay: string): number {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS
  );
}

/**
 * How a task's due date stands right now.
 *
 * The same four-member shape `reminders.dueStateFor` already produces, so
 * phase 4 can swap that function for this one without changing the type that
 * flows into `reminderEmail`. `unknown` is a member rather than an absence:
 * an unreadable due date is the case most in need of a human and must never
 * be dropped or defaulted (ADR 0010).
 */
export type DueState =
  | { kind: 'unknown' }
  | { kind: 'upcoming' }
  | { kind: 'today' }
  | { kind: 'overdue'; days: number };

export function dueStateFor(
  nextDue: string | null | undefined,
  now: Date,
  householdTimeZone: unknown
): DueState {
  const zone = normalizeHouseholdTimeZone(householdTimeZone);

  if (zone === HOUSEHOLD_TIMEZONE_UNSET) {
    // The instant rule, kept identical to `reminders.dueStateFor`. Any change
    // to it is a behaviour change for every household in production, so it
    // stays a transcription rather than a re-derivation, and
    // `dueDay.test.ts` asserts the two agree.
    const parsed = nextDue ? Date.parse(nextDue) : NaN;
    if (!Number.isFinite(parsed)) return { kind: 'unknown' };
    const diffMs = now.getTime() - parsed;
    if (diffMs < 0) return { kind: 'upcoming' };
    const days = Math.floor(diffMs / DAY_MS);
    return days <= 0 ? { kind: 'today' } : { kind: 'overdue', days };
  }

  const dueDay = nextDue ? localDay(nextDue, zone) : null;
  const today = localDay(now, zone);
  if (dueDay === null || today === null) return { kind: 'unknown' };

  const days = calendarDaysBetween(dueDay, today);
  if (days < 0) return { kind: 'upcoming' };
  if (days === 0) return { kind: 'today' };
  return { kind: 'overdue', days };
}

/**
 * The `overdue` boolean the server-computed surfaces ship (`taskService`'s
 * sitter/kiosk/tag projections, `sitterBrief`).
 *
 * Under the instant rule this is the same lexicographic comparison those call
 * sites make today — `nextDue < nowIso` — not a re-derivation through
 * `Date.parse`. The two differ for a `nextDue` that is a valid instant written
 * in a form that does not sort lexicographically against
 * `Date.prototype.toISOString()` output (an offset other than `Z`, a missing
 * `Z`, fewer than four year digits). `models/schemas.ts` validates `nextDue`
 * with Zod's `.datetime()`, which by default rejects offsets, so those forms
 * should not exist — but "should not exist" is not the same as "does not", and
 * a helper meant to be swapped in for an expression has to reproduce the
 * expression, including where it is wrong.
 */
export function isOverdue(
  nextDue: string | null | undefined,
  now: Date,
  householdTimeZone: unknown
): boolean {
  const zone = normalizeHouseholdTimeZone(householdTimeZone);
  if (zone === HOUSEHOLD_TIMEZONE_UNSET) {
    return typeof nextDue === 'string' && nextDue < now.toISOString();
  }
  return dueStateFor(nextDue, now, zone).kind === 'overdue';
}

/**
 * Whole days overdue, or `null` when the due date cannot be read.
 *
 * `escalationRule.daysOverdue` returns `0` for an unreadable date and
 * `digestReport.wholeDaysOverdue` returns `null`; this returns `null`, and the
 * equivalence test states that difference rather than papering over it.
 * Phase 4's swap in `escalationRule` therefore has to say what an unreadable
 * date should do about escalation — today it silently means "not overdue",
 * which is a real decision hiding in a `?? 0`.
 */
export function wholeDaysOverdue(
  nextDue: string | null | undefined,
  now: Date,
  householdTimeZone: unknown
): number | null {
  const state = dueStateFor(nextDue, now, householdTimeZone);
  switch (state.kind) {
    case 'unknown':
      return null;
    case 'overdue':
      return state.days;
    default:
      return 0;
  }
}

/**
 * The instant to hand `taskService.getTasksDueBy` as its `GSI1SK <= cutoff`
 * range end, for a window of `windowDays` calendar days.
 *
 * ADR 0025 §1: the GSI range query stays usable by widening the cutoff and
 * applying the exact calendar-day predicate in memory, which every caller
 * already does for its other filters. Widening is safe in one direction only.
 * A cutoff that is too EARLY drops rows the predicate would have kept, and
 * nothing downstream can tell a short read from a complete one — the same
 * failure shape as the `Limit: 100` truncation `sitterService` documents,
 * where the missing rows were silently the oldest ones.
 *
 * So the cutoff is the LATER of two instants, and the second one is not
 * decoration. The end of the window's final local day is the exact bound for
 * the calendar-day predicate, and it is USUALLY later than `now + N×24h` —
 * but not always. A spring-forward inside the window makes those N local days
 * 23 hours shorter in elapsed time, so for a `now` sitting within an hour of
 * local midnight the calendar cutoff lands EARLIER than the instant one.
 * Worked case, from the fixture table in the test file: at
 * `2027-03-14T04:30Z` (23:30 on 13 March in New York) with a one-day window,
 * the end of 14 March is `2027-03-15T03:59:59.999Z` and `now + 24h` is
 * `2027-03-15T04:30:00Z`. Taking the maximum keeps the read a superset under
 * both rules, which is what a household changing its zone mid-flight needs.
 *
 * `windowDays: 0` means "through the end of today", which is the reminder
 * scan's natural shape once #343 is answered. This function takes no position
 * on whether it should be.
 */
export function dueWindowCutoff(now: Date, windowDays: number, householdTimeZone: unknown): string {
  const zone = normalizeHouseholdTimeZone(householdTimeZone);
  const instantCutoff = new Date(now.getTime() + windowDays * DAY_MS).toISOString();
  if (zone === HOUSEHOLD_TIMEZONE_UNSET) return instantCutoff;

  const today = localDay(now, zone);
  // `now` is a Date, so `localDay` only fails on an Invalid Date. Falling back
  // to the instant cutoff keeps the read wide; deriving a day from a broken
  // clock would narrow it.
  if (today === null) return instantCutoff;

  const lastDayUtcMidnight = Date.parse(`${today}T00:00:00Z`) + windowDays * DAY_MS;

  // The end of the final local day, as an instant: step to the START of the
  // day after and back off a millisecond. Local day lengths are 23, 24 or 25
  // hours and only the tz database knows which, so the boundary is looked up
  // rather than computed.
  const dayAfter = new Date(lastDayUtcMidnight + DAY_MS).toISOString().slice(0, 10);
  const calendarCutoff = new Date(localMidnight(dayAfter, zone) - 1).toISOString();

  return calendarCutoff > instantCutoff ? calendarCutoff : instantCutoff;
}

/**
 * The instant at which `day` (a `YYYY-MM-DD` label) begins in `timeZone`.
 *
 * `Intl` only converts instant → wall clock, so this direction is solved
 * rather than looked up: take the offset at a first guess, subtract it, then
 * re-read the offset at the corrected instant and subtract again. The second
 * pass is what makes a DST day right — the first guess can sit on the other
 * side of the transition from the answer, and one pass would leave it an hour
 * out.
 *
 * On a spring-forward day in a zone whose transition is AT midnight, the local
 * midnight does not exist. Both passes then converge on the first instant that
 * does (01:00 local), which is the correct start of that day and the only
 * available answer.
 */
function localMidnight(day: string, timeZone: string): number {
  const wallClock = Date.parse(`${day}T00:00:00Z`);
  const firstPass = wallClock - offsetAt(wallClock, timeZone);
  return wallClock - offsetAt(firstPass, timeZone);
}

/** `timeZone`'s UTC offset in milliseconds at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  const asUtc = Date.parse(
    `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`
  );
  return asUtc - instant;
}
