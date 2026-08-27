# 0010 — A settled read with no data is its own state, not an empty one

**Status:** Accepted

**Date:** 2026-08-27

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0009](0009-three-state-grounding-verdict.md) (same rule, applied to
the grounding guard's verdict rather than to a read)

## Context

The same defect has now been found and fixed sixteen times, in four separate
audits, and it has never been written down. #319, #320, #326, #327, #328, #338,
#339, #341, #347 and #348 are all one bug: a value that was never read is
published as though it had been, because the code has two states where the
world has three.

A TanStack Query result is in exactly one of three situations:

1. **in flight** — the answer is not back yet;
2. **settled with data** — we know the answer;
3. **settled without data** — the read failed, and we know nothing.

Almost every instance of this defect comes from code that models two. Either
the third state is coalesced into a confident value (`(plants ?? []).length`
renders a failed read as the number `0`), or it is collapsed into silence
(`if (!data) return null` renders a failed read as an absent card, identical to
a card with nothing to say).

The silent form is the more dangerous of the two, because the reader supplies
the missing meaning themselves and supplies it wrongly. An absent card is read
as an all-clear. #351: `ClimateCard` is the only surface carrying the freeze
warning ("Low of X°C tonight. Bring tender plants indoors."), and a failed
climate read removed it with no trace on the night it mattered. #350:
`CareGuideCard` was the only surface on `PlantDetailPage` carrying pet
toxicity — a fact its own docstring called "actively dangerous to miss" — and a
Perenual outage discarded it in a way indistinguishable from "this species has
no guide". #349: a failed API-key read rendered "Active keys (0)" and "No keys
yet" while live keys still granted programmatic access to household data.

Nothing was lying in any of those three. Each was simply silent in a place
where silence already means something.

## Decision

**A settled read that produced no data is a distinct outcome and must be
rendered as one.** Concretely, for every query whose result reaches the UI:

- **In flight renders nothing, or a loading affordance.** An unsettled read is
  not an answer either way, and must never be given the "we checked" rendering.
- **Settled-without-data says so, in words.** Not a zero, not a blank, not an
  empty list, not an absent card. The copy names what is unknown rather than
  what is fine: "We couldn't read your local weather just now, so any frost,
  heat, or rain warning for tonight is unchecked rather than clear."
- **A genuine empty is allowed to be empty**, and is distinguished from the
  above. `null` returned by a provider ("no care guide for this species") is an
  answer; `undefined` after settling is not. `CareGuideCard` now branches on
  exactly that difference.
- **A safety-relevant fact does not share a fetch with anything optional.**
  Toxicity moved out of `CareGuideCard` and onto `PetToxicityNote`, which
  `PlantDetailPage` mounts on its own query, so an outage in the long-form
  prose can no longer take the warning with it.

Absence is only acceptable where absence asserts nothing. That judgement is a
human one and it gets recorded, per entry, in the gate's baseline below.

## Enforcement

`frontend/scripts/check-settled-read-states.mjs`, run by `npm run reads:check`
in `npm run verify` and in CI's **required** `Lint` job. It is a two-directional
ratchet over `settled-read-states-baseline.json`: a new occurrence fails, and a
baseline entry that no longer matches anything also fails, so the list can only
shrink and a fix cannot leave its own permission behind.

The gate is deliberately narrow, and the honest limits are these:

- It detects **one shape** — a `useQuery` destructured for `data` without any
  outcome field, plus an `if (!data) return null` guard. That is the shape that
  produced #350 and #351.
- It does **not** detect the coalescing shape (`data?.length ?? 0`,
  `(tasks ?? [])`) that produced #348 and #349. Distinguishing that from a
  legitimate default needs type information the scanner does not have. Those
  stay a review concern, and this ADR is the rule reviewers cite.
- It does **not** require an `isError` branch, because the codebase's own
  correct idiom is frequently `data === undefined` after the loading guard,
  which reads no error field at all. A gate demanding `isError` would fail
  `AnalyticsPage`, which is right.

A gate that caught everything would be a gate nobody could keep green. This one
catches the recurrence with the worst consequence and states plainly what it
leaves to people.

## Consequences

- **Four occurrences are accepted, with reasons.** `HouseholdSwitcher`,
  `YearInReviewCard`, `PhotoTimeline` and `SuggestedCareCard` all vanish on a
  failed read, and none of them carries a warning, a count, or a safety fact —
  their absence asserts nothing a reader would act on. Each baseline entry says
  why in a sentence. These are judgements, not exemptions: if one of those
  components ever gains a warning, its entry stops being true and must go.
- **`PlantDetailPage` makes one more request** for an enriched plant
  (`/species/:id` for toxicity alongside `/species/:id/guide` for the guide).
  That is the cost of decoupling a safety fact from optional prose, and it is
  the right trade: the extra call is cached for an hour and never retried.
- **More surfaces now show an error where they used to show nothing.** A
  household on a flaky connection will see "Local climate unavailable" instead
  of a clean dashboard. That is the intended change. A clean dashboard was not
  a better experience, it was a wrong one.
- **The rule is now citable.** Sixteen fixes were made without one, which is why
  there were sixteen. The next reviewer can point at a decision instead of
  re-deriving the argument.
