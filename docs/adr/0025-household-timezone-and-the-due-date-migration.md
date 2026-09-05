# 0025 — A due date is a calendar day in the household's zone, and the migration to it is staged

**Status:** Proposed

**Date:** 2026-09-05

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0010](0010-settled-read-states.md) (why "no zone set" is a
state rather than a default), [ADR 0018](0018-one-assignment-resolver-for-escalation-and-rotation.md)
(`escalatedForDue` pins an occurrence by its exact `nextDue` string),
[ADR 0017](0017-cross-home-today-is-a-work-queue-not-a-global-view.md) (the one
surface that already asks whose day it is), issues #342 (this), #346 and #542
(fixed symptoms), #343 (open, deliberately deferred).

## Context

Watering a plant is something you do on a **day**. The 2023 proof-of-concept
modelled a due date as `DATEONLY` and was right. The current rewrite models it
as a full ISO instant — `nextDue: z.string().datetime()` in
`models/schemas.ts`, which rejects `YYYY-MM-DD` — and every question the
product asks about that date is an instant comparison evaluated in the
process's zone, which is UTC on Lambda. When this ADR was written no `TZ` was
set anywhere in `infrastructure/`: the whole system rested on the AWS platform
default, and the only place that assumption was written down was a docstring in
`services/doubleCareRules.ts`. #590 has since pinned it —
`infrastructure/modules/api/main.tf` sets `TZ = "UTC"` on the Lambda
environment, and `backend/tests/unit/config/lambdaTimeZone.test.ts` fails if
that is removed — so the zone is now a stated setting rather than an inherited
default. That makes the dependency safe to rest on; it does not remove it,
which is still phase 5's job below.

That single modelling choice is upstream of a family of defects this repo has
been fixing one at a time: #346 (a plant added at 6pm was already overdue),
#542 ("mark done, refresh, still upcoming" — the seven-day window is an
instant window), #343 (the reminder scan reminds the evening before).

### What already exists, and what does not

The issue's title says there is "no household timezone", and half of that is
now stale. **Per-user IANA zones exist and work.**
`NotificationPreferences.timezone` is validated on write with
`isValidTimeZone`, and `reminders.ts` resolves `memberPrefs.timezone` and
threads it through the whole reminder run. Quiet hours (`isInDndWindow`), the
reminder dedupe marker and the push tag (`localDateKey(now, timeZone)`), and
the care-credit dedupe key in `householdEmails.ts` are all correctly
zone-aware.

What never got a zone is the **due-date math**. `reminders.ts` is the sharpest
illustration: it has the member's zone in hand and does not use it for the due
decision. `dueStateFor` buckets by `Math.floor(diffMs / DAY_MS)` — a rolling
24 hours — and the scan's cutoff is `now + DUE_WINDOW_MS`, a rolling 24 hours
from whenever the hourly scan happened to run.

There is no household-level zone at all: `Household` carries `id`, `name`,
`location`, `escalateAfterDays`, `createdAt`, `createdBy`. The only
geographic field is a weather geocode, from which no zone is derived.

So the system has **three** notions of "when", none of them the household's:
the server's UTC instant, each member's prefs zone (used only for
notification plumbing), and each reader's browser zone (used for every label
and every overdue colour the user actually sees). Cross-home Today is the one
feature that resolves the question explicitly, and it resolves it to the
reader's browser: the client computes `endOfLocalDay()` and sends it as
`until`.

### Why this is not a patch

Reinterpreting `nextDue` changes the answer for every task that already
exists, in production, for households paying real money since 2026-09-01. It
is not a bug fix that can be judged by whether a test goes green; it is a
one-time reclassification of live data, and the direction and blast radius
have to be decided before it ships, not discovered afterwards. PR #361
reached the same conclusion from the other side and pinned the behaviour with
characterization tests rather than changing it, following the precedent #341
set.

## Decision

### 1. The target model: reinterpret, do not rewrite

**A task's due date is the calendar day, in the household's zone, on which
its stored `nextDue` instant falls.** `nextDue` keeps its type, its value and
its meaning as a stored instant; what changes is the comparison:

```
overdue  ⟺  localDay(now, tz) >  localDay(nextDue, tz)
due today ⟺ localDay(now, tz) == localDay(nextDue, tz)
```

**Stored values are not rewritten.** That is the load-bearing choice, and
three things force it:

- `nextDue` is the GSI1 sort key (`GSI1SK`), compared lexicographically by
  every `getTasksDueBy` range query. A date-only string would not sort
  against the instants already in the index.
- `escalatedForDue`, `helpAskedForDue` and every optimistic-concurrency
  `ConditionExpression` in `taskService`, `escalation.ts`, `askFamily.ts` and
  the four public handlers pin an occurrence by **exact string equality** with
  `nextDue`. Rewriting the value silently unpins every one of them: an
  occurrence already escalated would escalate again, an ask already made
  would re-fire, and in-flight completions would fail their condition check.
- A rewrite destroys the original instant, which is the only thing that could
  undo the migration. Reinterpretation is revertible by reverting the code.

The GSI range query stays usable: widen the cutoff by one day on each side and
apply the exact calendar-day predicate in memory, which every caller already
does for its other filters.

### 2. A household with no zone set keeps today's behaviour, exactly

`timezone` is `''` — never set — for every household that exists today, and
`''` is a distinct state from `'UTC'`, kept distinct all the way down to the
DynamoDB attribute being absent rather than empty (this PR;
`services/householdTimeZone.ts`).

- **`''` (never set) → today's rule, unchanged.** Instant comparison. Not
  "calendar day in UTC" — that is a different answer, and giving it to a
  household that was never asked would be the migration happening by accident.
- **A real zone, `'UTC'` included → the new rule.** A household that
  deliberately chooses UTC gets calendar-day-in-UTC: its task due `14:00Z`
  stays "due today" until midnight Z instead of flipping overdue at 14:00.

This makes the cutover **per household, gated on that household having a
zone**, which is the property that makes the whole thing survivable: it can
roll out household by household, it can stop, and a single household can be
reverted by clearing its zone.

The corollary has to be stated plainly, because it is the trap: **setting the
zone IS the cutover for that household.** No code may adopt a zone on a
household's behalf — not from a member's notification prefs, not from the
weather `location`, not from the admin's browser. The browser's
`Intl.DateTimeFormat().resolvedOptions().timeZone` may **seed the control**,
the way `NotificationSettings.tsx` already seeds its own; only an explicit
save may store it, and the UI must say what changes.

### 3. What changes for an existing task on the day of the cutover

For a household that sets a zone with offset `O` from UTC, at the moment the
new rule takes effect:

- **A task's overdue threshold moves from its `nextDue` instant to the end of
  its local due day.** Because `nextDue` always falls inside its own local
  day, that threshold is always **later or equal** — by up to 24 hours, and by
  exactly the remainder of the local day.
- **No task becomes overdue earlier than it is today.** Nothing moves toward
  more urgent. Tasks move `overdue → due today`, never `due today → overdue`.
- **The visible one-time effect** is that some tasks currently rendered as
  overdue on the server's surfaces (digest, reminder email, sitter/kiosk/
  caretaker/plant-tag views, all of which ship a server-computed `overdue`
  boolean) become "due today" for the rest of that local day. Between roughly
  midnight and 4–5am Eastern this affects a whole day's tasks at once; away
  from those hours it affects the tasks whose instants sit in the offset
  window.
- **The digest's day count can go UP by one**, in the opposite direction from
  the classification. `digestReport.wholeDaysOverdue` is
  `floor(elapsed_ms / 24h)`; a task due 23:00 local and digested at 08:00 the
  next morning scores 0 today and 1 under calendar days. That is the specific
  under-report #342 calls the dangerous direction, and fixing it makes the
  digest agree with what `TasksPage` has always shown.
- **The ICS feed republishes.** `DTSTART;VALUE=DATE` is built from the UTC
  components of the instant, so for every household behind UTC the all-day
  event moves one day **earlier** in subscribers' calendars — to the day the
  app has been showing all along. Subscribed calendars will re-render silently
  and without a diff the user can inspect.
- **Members whose browser zone differs from the household's will now see the
  server disagree with their own device.** Today every server surface is UTC
  and every client label is browser-local, so this disagreement already
  exists; after the cutover it is a deliberate one with a nameable owner
  ("your household is set to America/New_York"), which the UI must say
  somewhere. A member travelling is the common case, not the exotic one.

### 4. Can a task move backwards?

**In classification, yes — and only in the direction of less urgent.** A task
can move `overdue → due today`. It can never move `due today → overdue`, and
it can never move `upcoming → due` earlier than it does now.

**In the seven-day window, yes, in both directions, by one day at the edge.**
`getUpcomingTasks` computes `now + 7 days` as an instant; the calendar-day
version is "through the end of the 7th local day", which is later. A task
sitting just outside the window can appear; nothing that is inside it leaves,
because the boundary only moves outward.

**In stored data, no.** Nothing is rewritten, so no task's `nextDue` moves at
all — which is also why "backwards" is only ever a question about how a fixed
value is read.

### 5. What is irreversible

The code change is not. These are:

- **Notifications already delivered.** Reminders, digests, escalation emails
  and pushes sent under the new rule cannot be recalled. This is the whole
  irreversible surface, and it is why the rollout is per household.
- **A one-time duplicate reminder per household.** The daily marker is
  `REMINDED#<localDateKey>` and the push tag is
  `reminder-<household>-<localDateKey>`. If the definition of the day key
  changes in the same deploy, the marker written under the old key does not
  match the new one and the household can be reminded twice for the same day.
  **Therefore: do not change the day-key definition and the due-date rule in
  the same deploy.** The keys are already correct — they use the member's
  zone — so the fix is to leave them alone.
- **Re-fired escalations and asks, if `nextDue` is ever rewritten.**
  `escalatedForDue === nextDue` is how "this occurrence has had its one
  escalation" is stored. This is a consequence of the rejected design, listed
  here so nobody reintroduces it.
- **Any normalisation of the stored instant** — anchoring `nextDue` to local
  noon, say, so completion time-of-day stops deciding the local day. It
  destroys the original instant and unpins the occurrence tokens above. If it
  is ever wanted, it needs its own ADR and its own reversal plan; it is
  explicitly **not** part of this one.

### 6. The staging

Each phase is separately shippable and separately revertible.

| Phase | What lands                                                                                                                                                                                                                                                                                                   | Changes an answer?    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 1     | The zone is stored, validated and readable. Nothing consults it.                                                                                                                                                                                                                                             | No                    |
| 2     | Admin UI to set it, on `HouseholdPage` beside the Location card, seeded from the browser and saying what it changes. Still consulted by nothing.                                                                                                                                                             | No                    |
| 3     | One shared `localDay` helper, and a characterization test per surface pinning today's answers.                                                                                                                                                                                                               | No                    |
| 4     | Backend classification switches to calendar-day-in-zone **for households with a zone**: `taskService` overdue filter and projections, `getUpcomingTasks`, `digestReport`, `reminders.dueStateFor`, `escalationRule.daysOverdue`, `sitterBrief`, `crossHomeToday`, the plant-tag and caretaker handlers.      | **Yes — the cutover** |
| 5     | ICS all-day dates, and `getDailyCompletionCounts`, which today builds its buckets from a local midnight and keys them by UTC date — correct only because Lambda is UTC.                                                                                                                                      | Yes                   |
| 6     | The frontend collapses onto the household zone: `utils/date.ts` and its two copy-pasted duplicates in `TasksPage` and `AnalyticsPage`, `spaceOverview`, `useOverdueAlerts` (which is instant-based and already disagrees with the dashboard it feeds), `crossHomeTodayService.endOfLocalDay`, `firstDueIso`. | Yes                   |

Phase 4 is the one that needs a named date, a household to go first, and
someone watching the support inbox.

### 7. What this PR does

Phase 1, and only Phase 1. The zone is stored, validated with the same
`isValidTimeZone` the notification prefs use, readable on
`GET /households/{id}`, writable by an admin at
`PUT /households/{id}/timezone`, and **read by nothing**. Every due-date,
window, reminder, ICS and digest path still does exactly the instant math it
did before, and the tests assert that the field is inert.

## Consequences

- **The honest cost: a field nobody reads is a field that can rot.** Nothing
  exercises it end to end, so it can drift out of correctness silently until
  Phase 4 arrives. Accepted deliberately: the alternative is landing the
  cutover and the plumbing together, which is the shape that makes a
  reclassification of live data impossible to review.
- **`''` versus `'UTC'` is a distinction the whole plan rests on**, and it is
  one line away from being collapsed by a future default. It is enforced at
  three layers — the DynamoDB attribute is removed rather than emptied, the
  read path normalises through `normalizeHouseholdTimeZone`, and the tests
  assert `unset !== 'UTC'` directly.
- **`isValidTimeZone` moved to `utils/timeZone.ts`** so a module with no AWS
  imports can use it, and is re-exported from `notificationPrefs.ts` under its
  old name. One implementation, two names, no drift.
- **The zone is per household, not per member.** Members keep their own zone
  for quiet hours, which is right — when you may be disturbed is personal,
  when the plant needs water is not. The cost is a travelling or remote member
  seeing a due date that is not their own day, which is a real thing to
  explain in the UI and is still better than three zones none of which is
  anybody's.
- **Nothing here fixes #343**, and it should stay open. The reminder scan's
  rolling 24-hour window is a separate decision about when to send, which only
  becomes answerable once "which day is this task for" has an answer.
- **Month-end is still not modelled.** "Monthly" is `frequencyDays: 30`, so
  Jan 31 + 30 lands on Mar 2 and a monthly task walks ~5 days a year. A
  calendar-day due date does not fix a day-count recurrence; that is a
  separate decision about calendar recurrence and is out of scope here.
