import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOUSEHOLD_TIMEZONE_UNSET,
  calendarDaysBetween,
  dueRuleFor,
  dueStateFor,
  dueWindowCutoff,
  isOverdue,
  localDay,
  wholeDaysOverdue,
} from '../../../src/services/dueDay.js';
import { dueStateFor as remindersDueStateFor } from '../../../src/services/reminders.js';
import { wholeDaysOverdue as digestWholeDaysOverdue } from '../../../src/services/digestReport.js';
import { daysOverdue as escalationDaysOverdue } from '../../../src/services/escalationRule.js';

/**
 * ADR 0025 phase 3. Two suites with two different jobs.
 *
 * **The equivalence suite** is the reason this file matters. `services/
 * dueDay.ts` is called by nothing in production: it exists so phase 4's
 * cutover is a call-site swap rather than nine simultaneous rewrites of the
 * same arithmetic. An unused module rots, and the mitigation is to run it and
 * the four production expressions it will replace over the same table of
 * instants and assert they agree **for a household with no zone set**.
 *
 * That is ADR 0025 §2 — "a household with no zone set keeps today's behaviour,
 * exactly" — and it is the one claim about the migration that can be checked
 * before the cutover rather than after it. Every household in production has
 * no zone set, so the suite is also a proof that adopting the helper changes
 * no live answer on the day it is adopted.
 *
 * **The calendar-day suite** pins what the new rule does, including the cases
 * #342 reproduced: both DST transitions, both sides of UTC midnight, and the
 * safety property that a task can move `overdue → due today` and never the
 * other way.
 *
 * The fixtures are the ones from #342 and #343 rather than round numbers,
 * because the defects are at the boundaries and a table of noon instants is a
 * table that cannot fail.
 */

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Instants chosen to sit on the edges the inline expressions disagree at:
 * both US DST transitions, both sides of UTC midnight seen from a zone behind
 * and a zone ahead of it, a leap day, a month end, and the exact-boundary
 * cases where `floor(diff / 24h)` flips.
 */
const INSTANTS = [
  '2026-06-09T02:00:00.000Z', // #343's fixture: 22:00 the previous day in NY
  '2026-06-09T03:00:00.000Z',
  '2026-06-09T23:59:59.999Z',
  '2026-06-10T00:00:00.000Z', // UTC midnight exactly
  '2026-06-10T00:00:00.001Z',
  '2027-03-13T23:30:00.000Z', // #342 §1: the evening before spring-forward
  '2027-03-14T04:30:00.000Z',
  '2027-03-14T07:00:00.000Z', // 02:00 EST → 03:00 EDT
  '2026-10-31T04:30:00.000Z', // #342 §1: the fall-back mirror
  '2026-11-01T05:00:00.000Z', // 02:00 EDT → 01:00 EST
  '2026-11-01T06:00:00.000Z',
  '2026-06-01T20:00:00.000Z', // #342 §3: the ICS fixture
  '2026-06-09T00:00:00.000Z',
  '2028-02-29T12:00:00.000Z', // leap day
  '2026-01-31T23:00:00.000Z', // month end
  '2026-12-31T23:30:00.000Z', // year end
];

/** Every ordered pair of the instants above: `nextDue` × `now`. */
function pairs(): { nextDue: string; now: Date }[] {
  const out: { nextDue: string; now: Date }[] = [];
  for (const nextDue of INSTANTS) {
    for (const now of INSTANTS) out.push({ nextDue, now: new Date(now) });
  }
  return out;
}

function describePair(nextDue: string, now: Date): string {
  return `nextDue=${nextDue} now=${now.toISOString()}`;
}

// ---------------------------------------------------------------------------
// Equivalence: an unset zone reproduces today's answers, expression by
// expression. This is the suite that goes red if either side drifts.
// ---------------------------------------------------------------------------

describe('a household with no zone set keeps today’s behaviour, exactly (ADR 0025 §2)', () => {
  it('is on the instant rule, and any real zone — UTC included — is not', () => {
    expect(dueRuleFor(HOUSEHOLD_TIMEZONE_UNSET)).toBe('instant');
    expect(dueRuleFor(undefined)).toBe('instant');
    expect(dueRuleFor(null)).toBe('instant');
    expect(dueRuleFor(42)).toBe('instant');
    expect(dueRuleFor('Not/AZone')).toBe('instant');

    // The distinction the whole migration rests on: a household that chose UTC
    // asked for the new rule; one that was never asked did not.
    expect(dueRuleFor('UTC')).toBe('calendar-day');
    expect(dueRuleFor(NY)).toBe('calendar-day');
  });

  it('matches reminders.dueStateFor for every fixture pair', () => {
    for (const { nextDue, now } of pairs()) {
      expect(
        dueStateFor(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET),
        describePair(nextDue, now)
      ).toEqual(remindersDueStateFor(nextDue, now));
    }
  });

  it('matches reminders.dueStateFor on the unreadable and absent cases too', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    for (const nextDue of [null, undefined, '', 'not-a-date', '2026-13-45T99:99:99Z']) {
      expect(
        dueStateFor(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET),
        `nextDue=${String(nextDue)}`
      ).toEqual(remindersDueStateFor(nextDue, now));
    }
  });

  it('matches escalationRule.daysOverdue for every fixture pair', () => {
    for (const { nextDue, now } of pairs()) {
      expect(
        wholeDaysOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET),
        describePair(nextDue, now)
      ).toBe(escalationDaysOverdue({ nextDue }, now));
    }
  });

  it('matches digestReport.wholeDaysOverdue wherever the digest reports a number', () => {
    for (const { nextDue, now } of pairs()) {
      const digest = digestWholeDaysOverdue(nextDue, now);
      // The digest returns a negative count for a task that is not yet due and
      // never renders it (`gatherAtRisk` only reaches rows it has already
      // filtered as overdue). The helper reports 0 for "not overdue", so the
      // comparison is over the range the digest actually publishes.
      if (digest !== null && digest > 0) {
        expect(
          wholeDaysOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET),
          describePair(nextDue, now)
        ).toBe(digest);
      }
    }
  });

  it('states the one place the two production expressions already disagree', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    // escalationRule clamps an unreadable date to 0 — "not overdue" — while
    // digestReport returns null and renders "we could not read this". The
    // helper returns null, so phase 4's swap in escalationRule.ts has to make
    // that choice explicitly instead of inheriting it from a Math.max.
    expect(escalationDaysOverdue({ nextDue: 'not-a-date' }, now)).toBe(0);
    expect(digestWholeDaysOverdue('not-a-date', now)).toBeNull();
    expect(wholeDaysOverdue('not-a-date', now, HOUSEHOLD_TIMEZONE_UNSET)).toBeNull();
  });

  it('matches the `nextDue < nowIso` projection the server-computed surfaces ship', () => {
    for (const { nextDue, now } of pairs()) {
      expect(isOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET), describePair(nextDue, now)).toBe(
        nextDue < now.toISOString()
      );
    }
    expect(isOverdue(null, new Date(), HOUSEHOLD_TIMEZONE_UNSET)).toBe(false);
    expect(isOverdue(undefined, new Date(), HOUSEHOLD_TIMEZONE_UNSET)).toBe(false);
  });

  /**
   * The two `overdue` projections are inline expressions inside functions that
   * need DynamoDB to call, so the assertion above transcribes them rather than
   * importing them. A transcription that nobody re-checks is how a
   * characterization test goes stale without going red, so the transcription
   * is anchored to the source: change either expression and this fails,
   * pointing at the assertion that has to move with it.
   *
   * Same technique, and same reason, as `scripts/check-well-known.mjs`
   * asserting the deploy path by reading the workflow files.
   */
  it('the transcribed projections are still the expressions in the source', () => {
    const projections = [
      { file: 'backend/src/services/taskService.ts', expression: 'overdue: t.nextDue < nowIso,' },
      {
        file: 'backend/src/services/sitterBrief.ts',
        expression: 'overdue: task.nextDue < nowIso,',
      },
    ];
    for (const { file, expression } of projections) {
      expect(
        readFileSync(join(REPO_ROOT, file), 'utf8'),
        `${file} no longer contains \`${expression}\` — the transcription in the test above ` +
          'has to be updated to whatever replaced it, or dueDay.isOverdue is no longer ' +
          'equivalent to what that surface ships'
      ).toContain(expression);
    }
  });

  it('reproduces the reminder scan’s rolling 24h cutoff', () => {
    // reminders.ts: `cutoff = new Date(now.getTime() + DUE_WINDOW_MS)`.
    for (const iso of INSTANTS) {
      const now = new Date(iso);
      expect(dueWindowCutoff(now, 1, HOUSEHOLD_TIMEZONE_UNSET)).toBe(
        new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The calendar-day rule: what phase 4 will start answering.
// ---------------------------------------------------------------------------

describe('localDay', () => {
  it('resolves an instant to the calendar day it falls on in the zone', () => {
    expect(localDay('2026-06-10T02:00:00.000Z', NY)).toBe('2026-06-09');
    expect(localDay('2026-06-10T02:00:00.000Z', 'UTC')).toBe('2026-06-10');
    expect(localDay('2026-06-10T02:00:00.000Z', TOKYO)).toBe('2026-06-10');
    // A zone ahead of UTC crosses the other way.
    expect(localDay('2026-06-09T16:00:00.000Z', TOKYO)).toBe('2026-06-10');
  });

  it('pads a single-digit month and day, so the labels sort lexicographically', () => {
    expect(localDay('2026-01-02T12:00:00.000Z', 'UTC')).toBe('2026-01-02');
  });

  it('returns null for an instant it cannot read, rather than today', () => {
    expect(localDay('not-a-date', NY)).toBeNull();
    expect(localDay('', NY)).toBeNull();
    expect(localDay(Number.NaN, NY)).toBeNull();
  });
});

describe('calendarDaysBetween', () => {
  it('counts midnights, so a 23-hour and a 25-hour day each count as one', () => {
    expect(calendarDaysBetween('2027-03-14', '2027-03-15')).toBe(1); // spring forward
    expect(calendarDaysBetween('2026-11-01', '2026-11-02')).toBe(1); // fall back
    expect(calendarDaysBetween('2026-06-09', '2026-06-09')).toBe(0);
    expect(calendarDaysBetween('2026-06-10', '2026-06-09')).toBe(-1);
    expect(calendarDaysBetween('2028-02-28', '2028-03-01')).toBe(2); // leap year
    expect(calendarDaysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('the calendar-day rule', () => {
  it('#343: a task the app calls “due Tuesday” is due today all of Tuesday', () => {
    // #343's exact fixture. nextDue is 22:00 Monday in NY.
    const nextDue = '2026-06-10T02:00:00.000Z';

    // Monday 23:00 local — before the local due day starts.
    expect(dueStateFor(nextDue, new Date('2026-06-09T03:00:00.000Z'), NY)).toEqual({
      kind: 'upcoming',
    });
    // All of Tuesday local, including after the instant passes.
    expect(dueStateFor(nextDue, new Date('2026-06-09T04:00:00.000Z'), NY)).toEqual({
      kind: 'today',
    });
    expect(dueStateFor(nextDue, new Date('2026-06-10T03:00:00.000Z'), NY)).toEqual({
      kind: 'today',
    });
    // Wednesday local.
    expect(dueStateFor(nextDue, new Date('2026-06-10T04:00:00.000Z'), NY)).toEqual({
      kind: 'overdue',
      days: 1,
    });
  });

  it('#342 §1: a DST week counts as seven calendar days, not 167 hours', () => {
    // Completed 2027-03-13 23:30 EST; the stored instant is +7×24h from there.
    const nextDue = '2027-03-21T04:30:00.000Z';
    expect(localDay(nextDue, NY)).toBe('2027-03-21');
    // The instant rule renders it on the 21st in the browser and the app has
    // always said the 20th. Phase 4 does not move the instant — it makes the
    // server agree with the day the instant falls on, which is the 21st, and
    // #342's "correct: Sat Mar 20" is an argument about the recurrence
    // anchor (item 6), not about this comparison. Pinned here so the two are
    // not conflated when phase 4 lands.
    expect(dueStateFor(nextDue, new Date('2027-03-21T12:00:00.000Z'), NY)).toEqual({
      kind: 'today',
    });
  });

  it('UTC is a real zone: a task due 14:00Z stays due today until midnight Z', () => {
    // ADR 0025 §2's worked example, and it is about the `overdue` BOOLEAN the
    // server-computed surfaces ship — `dueStateFor` already says "today" for
    // the first 24 hours under either rule, so the boolean is where a
    // household that chooses UTC sees a difference.
    const nextDue = '2026-06-09T14:00:00.000Z';
    const afternoon = new Date('2026-06-09T18:00:00.000Z');

    expect(isOverdue(nextDue, afternoon, HOUSEHOLD_TIMEZONE_UNSET)).toBe(true);
    expect(isOverdue(nextDue, afternoon, 'UTC')).toBe(false);
    // And it does flip, at midnight Z.
    expect(isOverdue(nextDue, new Date('2026-06-09T23:59:59.999Z'), 'UTC')).toBe(false);
    expect(isOverdue(nextDue, new Date('2026-06-10T00:00:00.000Z'), 'UTC')).toBe(true);
  });

  it('counts days overdue by calendar date, the direction #342 calls dangerous', () => {
    // #342 §4: nextDue 2026-06-08 23:00-04:00, read at 2026-06-09 08:00 EDT.
    const nextDue = '2026-06-09T03:00:00.000Z';
    const now = new Date('2026-06-09T12:00:00.000Z');
    expect(digestWholeDaysOverdue(nextDue, now)).toBe(0); // "ready for a little care today"
    expect(wholeDaysOverdue(nextDue, now, NY)).toBe(1); // what TasksPage has always shown
  });

  it('an unreadable due date is unknown under both rules, never today', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    for (const zone of [HOUSEHOLD_TIMEZONE_UNSET, 'UTC', NY, TOKYO]) {
      expect(dueStateFor('not-a-date', now, zone), zone || '(unset)').toEqual({ kind: 'unknown' });
      expect(dueStateFor(null, now, zone), zone || '(unset)').toEqual({ kind: 'unknown' });
    }
  });
});

describe('the safety property, and the place ADR 0025 §4 overstates it', () => {
  /**
   * ADR 0025 §4 is the claim the cutover is sold on: "A task can move `overdue
   * → due today`. It can never move `due today → overdue`, and it can never
   * move `upcoming → due` earlier than it does now."
   *
   * For the OVERDUE THRESHOLD that is exactly right, and it is proved below
   * over every fixture pair in four zones rather than argued. The threshold
   * moves from the `nextDue` instant to the end of that instant's local day,
   * and `nextDue` always falls inside its own local day, so the threshold is
   * always later or equal.
   *
   * **It is not right for `reminders.dueStateFor`'s day buckets**, and that is
   * a correction to the ADR rather than a defect in this module. That
   * function's `today` does not mean "due on today's date" — it means
   * "overdue by less than 24 elapsed hours", the rolling bucket #342 §4 and
   * #343 are both about. A task whose local due day has passed but whose
   * instant is under 24 hours old is `today` under the instant rule and
   * `overdue, days: 1` under the calendar-day rule. That is MORE urgent, in
   * the direction §4 says cannot happen, and it has two live consequences the
   * cutover has to be planned around:
   *
   *   - `escalationRule.escalationCandidates` fires on `daysOverdue >=
   *     threshold`, so auto-handoff (ADR 0018) reaches its threshold up to a
   *     day earlier and hands a task to the household sooner than it does now.
   *   - `reminders.isRestingOverdue` drops a task out of the daily reminder at
   *     `REMINDER_OVERDUE_DECAY_DAYS`, so a task goes quiet up to a day
   *     earlier.
   *
   * Neither is a disaster and both may be wanted — a day count that agrees
   * with the calendar is the point of the migration. What matters is that they
   * are decisions rather than surprises, so they are pinned here.
   */
  it('the overdue threshold never moves earlier — the real §4 guarantee', () => {
    for (const zone of ['UTC', NY, TOKYO, 'Australia/Lord_Howe']) {
      for (const { nextDue, now } of pairs()) {
        if (isOverdue(nextDue, now, zone)) {
          expect(
            isOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET),
            `${describePair(nextDue, now)} in ${zone} is overdue under the calendar rule ` +
              'but not under the instant rule — the cutover would make it MORE urgent'
          ).toBe(true);
        }
      }
    }
  });

  it('§4’s `upcoming → due` clause is wrong: a task becomes due at local midnight', () => {
    // ADR 0025 §4: "it can never move `upcoming → due` earlier than it does
    // now." A calendar-day rule makes a task due for the whole of its local
    // day, which starts at local midnight — necessarily earlier than an
    // instant later that day. This is inherent to the target model, not a bug
    // in it, and it is arguably what #343 is asking for; it is simply not what
    // §4 says.
    const nextDue = '2026-06-09T02:00:00.000Z';
    const justAfterLocalMidnight = new Date('2026-06-09T00:00:00.000Z');

    expect(dueStateFor(nextDue, justAfterLocalMidnight, HOUSEHOLD_TIMEZONE_UNSET)).toEqual({
      kind: 'upcoming',
    });
    expect(dueStateFor(nextDue, justAfterLocalMidnight, 'UTC')).toEqual({ kind: 'today' });

    // Bounded, though: never more than a day early, and never overdue early.
    for (const zone of ['UTC', NY, TOKYO, 'Australia/Lord_Howe']) {
      for (const { nextDue: due, now } of pairs()) {
        if (dueStateFor(due, now, HOUSEHOLD_TIMEZONE_UNSET).kind === 'upcoming') {
          expect(dueStateFor(due, now, zone).kind, `${describePair(due, now)} in ${zone}`).not.toBe(
            'overdue'
          );
        }
      }
    }
  });

  it('but the rolling-24h `today` bucket CAN become `overdue`, which §4 does not allow for', () => {
    // 22:00 on 8 June in New York, read at 19:59:59 on 9 June — under a day
    // elapsed, but a calendar day has turned.
    const nextDue = '2026-06-09T02:00:00.000Z';
    const now = new Date('2026-06-09T23:59:59.999Z');

    expect(remindersDueStateFor(nextDue, now)).toEqual({ kind: 'today' });
    expect(dueStateFor(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET)).toEqual({ kind: 'today' });
    expect(dueStateFor(nextDue, now, NY)).toEqual({ kind: 'overdue', days: 1 });

    // The overdue BOOLEAN is unaffected: it was already true under both rules,
    // which is why the §4 guarantee holds where the ADR's own worked examples
    // apply it and fails only for the day buckets.
    expect(isOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET)).toBe(true);
    expect(isOverdue(nextDue, now, NY)).toBe(true);
  });

  it('day counts move by at most one, in EITHER direction', () => {
    for (const zone of ['UTC', NY, TOKYO]) {
      for (const { nextDue, now } of pairs()) {
        const before = wholeDaysOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET) ?? 0;
        const after = wholeDaysOverdue(nextDue, now, zone) ?? 0;
        expect(
          Math.abs(after - before),
          `${describePair(nextDue, now)} in ${zone}: ${before} → ${after}`
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('and it goes DOWN as well as up, which the ADR only anticipates one way', () => {
    // ADR 0025 §3 names only the upward move ("the digest's day count can go
    // UP by one"). It goes down too, for a `now` late in a local day behind
    // UTC: elapsed hours have crossed one more 24h boundary than the calendar
    // has crossed midnights.
    const nextDue = '2026-10-31T04:30:00.000Z'; // 00:30 on 31 October in NY
    const now = new Date('2027-03-14T04:30:00.000Z'); // 23:30 on 13 March in NY

    expect(wholeDaysOverdue(nextDue, now, HOUSEHOLD_TIMEZONE_UNSET)).toBe(134);
    expect(wholeDaysOverdue(nextDue, now, NY)).toBe(133);

    // Which means auto-handoff and the reminder's 14-day decay can fire a day
    // LATER as well as a day earlier. Both directions are one day; neither is
    // unbounded.
  });
});

describe('dueWindowCutoff', () => {
  it('widens outward: the calendar-day cutoff is never earlier than the instant one', () => {
    for (const iso of INSTANTS) {
      const now = new Date(iso);
      for (const windowDays of [0, 1, 7]) {
        const instantCutoff = new Date(
          now.getTime() + windowDays * 24 * 60 * 60 * 1000
        ).toISOString();
        for (const zone of ['UTC', NY, TOKYO]) {
          expect(
            dueWindowCutoff(now, windowDays, zone) >= instantCutoff,
            `${iso} +${windowDays}d in ${zone}: ${dueWindowCutoff(now, windowDays, zone)} < ${instantCutoff}`
          ).toBe(true);
        }
      }
    }
  });

  it('lands on the last millisecond of the window’s final local day', () => {
    const now = new Date('2026-06-09T18:00:00.000Z'); // 14:00 in NY
    // Through the end of today, local.
    expect(dueWindowCutoff(now, 0, NY)).toBe('2026-06-10T03:59:59.999Z');
    expect(localDay(dueWindowCutoff(now, 0, NY), NY)).toBe('2026-06-09');
    // Through the end of the 7th day.
    expect(localDay(dueWindowCutoff(now, 7, NY), NY)).toBe('2026-06-16');
  });

  it('keeps the instant cutoff when a spring-forward makes the local window shorter', () => {
    // The case the `max` in dueWindowCutoff exists for: 23:30 on 13 March in
    // New York, one-day window, and 14 March is 23 hours long. The end of the
    // final local day is EARLIER than now + 24h, so the calendar bound alone
    // would drop rows the instant rule would have kept.
    const now = new Date('2027-03-14T04:30:00.000Z');
    expect(localDay(now, NY)).toBe('2027-03-13');
    // The end of 14 March in New York is 2027-03-15T03:59:59.999Z — shown here
    // by asking for a window that ends on it from a `now` earlier in the day,
    // where the instant bound is not the larger of the two.
    const earlier = new Date('2027-03-13T18:00:00.000Z'); // 13:00 on 13 March
    expect(dueWindowCutoff(earlier, 1, NY)).toBe('2027-03-15T03:59:59.999Z');
    // From 23:30, `now + 24h` is later than that, so it wins.
    expect(dueWindowCutoff(now, 1, NY)).toBe('2027-03-15T04:30:00.000Z');
  });

  it('survives both DST transitions', () => {
    // Spring forward: 2027-03-14 is 23 hours long in New York.
    const spring = new Date('2027-03-13T18:00:00.000Z');
    expect(localDay(dueWindowCutoff(spring, 1, NY), NY)).toBe('2027-03-14');
    // Fall back: 2026-11-01 is 25 hours long.
    const fall = new Date('2026-10-31T18:00:00.000Z');
    expect(localDay(dueWindowCutoff(fall, 1, NY), NY)).toBe('2026-11-01');
  });
});
