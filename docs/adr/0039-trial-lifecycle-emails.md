# 0039 — Two emails at the end of the no-card trial: day 10 and day 14, off by default

**Status:** Proposed

**Date:** 2026-10-21

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0027](0027-no-card-garden-trial.md) (the trial; this amends its decision 9),
[ADR 0021](0021-email-rendering-and-usefulness.md) (HTML, locale, one-click unsubscribe),
[ADR 0022](0022-email-deliverability-and-bounce-handling.md) (suppression),
[ADR 0023](0023-billing-lifecycle-emails.md) (billing mail is transactional; this is not),
[ADR 0010](0010-settled-read-states.md) (a read that failed is not a zero).

## Context

ADR 0027 decided that a household is told about its trial "in the app, and only there. No email is
sent." That held while the trial was new. The trial now ends for households that have not opened
the app in days, and the in-app notice cannot reach them. The cost of that is not a lost charge,
because nothing is charged. It is a household that finds, a week later, that it cannot add a
twenty-first plant and does not know why, or that a tool it used has stopped.

Two emails are enough: one while the household can still decide, one after it has fallen back,
saying plainly that nothing was deleted.

## Decision

1. **Two emails, one scan.** `trial_day10` goes to a household whose trial is active and ends in
   four days or fewer. `trial_day14` goes to a household whose trial ended within the last three
   days. A daily EventBridge rule runs the `trialEmails` job on the existing `digests` Lambda (the
   way the trash purge does), so shipping it adds a schedule, not a Lambda or an entry in the
   hard-coded deploy lists.

2. **Off by default, and fail-closed.** `TRIAL_LIFECYCLE_EMAILS_ENABLED` must be exactly `true`.
   Unset, `1`, `TRUE` or a padded value is off. With it off the run reads nothing and sends
   nothing. In Terraform, `trial_lifecycle_emails_enabled` defaults to false and is false in the
   committed tfvars; with it off the variable is not set on the Lambda and the rule is `DISABLED`,
   so a build that predates the job can never receive it (an unrecognized job falls through to the
   weekly digest routine).

3. **No new tracking, no new writes to the household.** The scan reads the trial through
   `noCardTrialState`, which already ignores a household with Stripe state or a running gift, so a
   household that subscribed is never told it is "back on Seedling". The numbers in the email are
   computed from rows that already exist: plants added in the trial window (`PLANT#` rows by
   `createdAt`) and care tasks marked done (`TaskCompletion` rows in the activity partition), plus
   the plant and member counters on the household row. The only new rows are the exactly-once
   markers, with a 60-day TTL.

4. **Reminders delivered is not in the email.** It was asked for and cannot be computed honestly:
   the only record is the `ReminderMarker` row, which has a 48-hour TTL. A number built from it
   would describe the last two days and be read as the trial. It stays out until a durable record
   exists, which would be new tracking and a separate decision.

5. **Honest about the fallback.** Both emails say what Seedling holds, with every figure read from
   the plan catalog, and that everything already made is kept. The day-14 email says so in its
   subject. It names an over-cap state (more than 20 plants, more than 3 people) only when the
   counter was read and is over; an unread counter says nothing rather than guessing.

6. **Absence is not an achievement.** A household with no plants is told "You have not added a
   plant yet." A household with plants and no completed task is told "No care task has been marked
   done yet." A count that could not be read is left out and the email says the counts could not be
   loaded. None of them prints a zero as a result.

7. **Not marketing pressure.** No discount, no code, no countdown beyond the plain end date, no
   exclamation marks. The one price named is the catalog's monthly Garden price, once. A test pins
   the banned phrases.

8. **The existing mail rules apply.**
   - _Consent._ These are lifecycle mail, not transactional like ADR 0023's, so they honor
     `prefs.email` and a new `trialNotices` preference (default on with email, like `yearRecap`).
     The email carries one-click unsubscribe (`List-Unsubscribe` and `List-Unsubscribe-Post`, new
     category `trial_notices`) that switches `trialNotices` off.
   - _Quiet hours._ A recipient inside their do-not-disturb window is skipped without claiming the
     send; the next daily scan delivers.
   - _Suppression._ Sent through `emailNotifier.sendEmailAccepted`. A suppressed address, or an
     unreadable suppression store, gets nothing and the slot is released, so an address resumed
     later still receives it inside the window.
   - _Replies._ `Reply-To` is the configured support inbox, which the existing
     `emailNotifier` sets. The email invites a reply.
   - _Exactly once._ A marker per household, kind and admin, in the checkout-recovery shape
     (claim, lease, finalize, release).
   - _Recipients._ Admins only, as for billing mail: they are the only people who can act.

9. **No backfill.** The day-14 email is only for a trial that ended in the last three days, so
   turning the flag on later does not mail every household whose trial ended long ago.

## Consequences

- ADR 0027 decision 9 ("No email is sent") is amended: with the flag on, two emails are sent. With
  it off, it is still true. `docs/billing.md` says both.
- `trialNotices` is a new preference. It is settable through the unsubscribe link and the
  notification-preferences record; the Settings screen does not yet show a switch for it. Adding
  one is a small frontend change and is not in this decision.
- Spanish copy is included so a Spanish-language household is not mailed in English. It was written
  without a native review and should be read by one before the flag is switched on.
- A scan that misses a day costs a day, not the email, because both windows are several days wide.
  A scan that is down for more than three days after a trial ends skips that household's day-14
  email on purpose.
- The facts are computed per mailed household at send time (two count queries and one point read),
  not per household scanned, so the cost of the daily pass is the existing household listing.
