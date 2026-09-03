# 0010 — A settled read with no data is its own state, not an empty one

**Status:** Accepted

**Date:** 2026-08-27

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0009](0009-three-state-grounding-verdict.md) (same rule, applied to
the grounding guard's verdict rather than to a read)

## Context

The same defect keeps being found and fixed, and it has never been written
down. #319, #320, #326, #327, #328, #338, #339, #341, #347 and #348 are all one
bug: a value that was never read is published as though it had been, because
the code has two states where the world has three. Ten pull requests
understates it, because several batched the same bug in several places at once
— #341's subject line is "six more places", #347's is "five more" — so the
count of individual fixes is comfortably past twenty, spread over four audits,
with no shared rule between them.

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

Two scripts, one rule, one ratchet shape, run together by `npm run reads:check`
(which fans out to every workspace that defines it) in `npm run verify` and in
CI's **required** `Lint` job:

- `frontend/scripts/check-settled-read-states.mjs` over `frontend/src`;
- `backend/scripts/check-settled-read-states.mjs` over `backend/src`, added
  2026-09-02. Until then the backend was enforced by hand, and that is how
  `identifyBudget.getUsage` got fixed — a failed DynamoDB read returns `null`,
  "we do not know" — while `leafHealthBudget.getUsage`, the same shape in the
  next file, kept returning `0` from its catch and was noticed only by chance
  in #388. A ratchet exists so the second does not depend on someone
  remembering the first.

Each is a two-directional ratchet over its own `settled-read-states-baseline.json`:
a new occurrence fails, and a baseline entry that no longer matches anything
also fails, so the list can only shrink and a fix cannot leave its own
permission behind.

Both gates are deliberately narrow, and the honest limits are these.

The **frontend** gate:

- detects **one shape** — a `useQuery` destructured for `data` without any
  outcome field, plus an `if (!data) return null` guard. That is the shape that
  produced #350 and #351.
- does **not** detect the coalescing shape (`data?.length ?? 0`,
  `(tasks ?? [])`) that produced #348 and #349. Distinguishing that from a
  legitimate default needs type information the scanner does not have. Those
  stay a review concern, and this ADR is the rule reviewers cite.
- does **not** require an `isError` branch, because the codebase's own
  correct idiom is frequently `data === undefined` after the loading guard,
  which reads no error field at all. A gate demanding `isError` would fail
  `AnalyticsPage`, which is right.

The **backend** gate looks for a read — a DynamoDB / S3 / SSM / Cognito
get-style command, a counter read-back via `UpdateCommand … ReturnValues`, a
`fetch`, or an awaited `getX()` / `lookupX()`-shaped call — whose failure is
caught and handed back as a value a genuine empty also produces:

- a catch whose last statement is `return 0` / `[]` / `{}` / `false` / `''` /
  `undefined`; `return null` when the try block also yields `null` on a
  success path; the same literal the try block uses as a default (`|| 'Someone'`
  and then `return 'Someone'`); or an object literal that names no failure
  state (`{ used: 0, limit, blocked: false }` against a success path that
  writes `blocked: used > limit`);
- a swallowing catch that leaves a `let x = <literal>` in place, or one
  followed by a single `return` that serves both "nothing there" and "could
  not look";
- `.catch(() => [])` (or `0`, `false`, `undefined`, a no-op block) chained onto
  a read.

It does **not** flag `result.Item?.used ?? 0` inside the try — a missing row
is a real zero, and that default is the codebase's correct idiom. It does
**not** flag a catch that ends in `throw` (whatever it returns before that is
a recognised condition such as `ConditionalCheckFailedException`), a named
state (`{ status: 'unavailable' }`; `available: false` against a success path
that writes `available: true`; `plantCount: null` where success never writes a
literal `null`), a defaulted variable the function then throws on, or a
write. Like the frontend gate, it does not judge consequence: a display name
and a spend cap are the same shape to it, and the baseline entry is where the
difference gets written down. Its own tests
(`backend/tests/unit/scripts/checkSettledReadStates.test.ts`) run the script
against fixtures for every shape above, in both directions.

A gate that caught everything would be a gate nobody could keep green. These
catch the recurrences with the worst consequences and state plainly what they
leave to people.

## Consequences

- **Four occurrences are accepted, with reasons.** `HouseholdSwitcher`,
  `YearInReviewCard`, `PhotoTimeline` and `SuggestedCareCard` all vanish on a
  failed read, and none of them carries a warning, a count, or a safety fact —
  their absence asserts nothing a reader would act on. Each baseline entry says
  why in a sentence. These are judgements, not exemptions: if one of those
  components ever gains a warning, its entry stops being true and must go.
- **The backend pins nine occurrences, all of them acceptances.** They are
  attribution fallbacks (`'Someone'`, an email local-part for an account with
  no name attribute) and cache reads whose miss and failure both correctly
  mean "ask the provider", where the provider result carries its own settled
  states. Same rule as the frontend's four: judgements, not exemptions. The
  baseline briefly carried a tenth entry that was NOT an acceptance —
  `leafHealthBudget.getUsage` returned `0` from a failed read, the number a
  household that has spent nothing this month also gets, and `isOverCap` read
  that as "under cap" — recorded as a KNOWN DEFECT so the count was pinned
  honestly rather than hidden. That fix landed on `main` before this gate did,
  so the entry went stale and was deleted here, exactly as its own text said
  it must be. That is the two-directional ratchet working: a fix is not
  finished until the line admitting the debt is gone.
- **Two backend reads were fixed on the way.** `enrichment`'s daily Perenual
  budget used to fail open by returning `{ used: 0, blocked: false }` — byte
  for byte a fresh day under budget — so no caller could tell a metered call
  from an unmetered one; it now returns `available: false` and the fail-open
  decision is made once, on purpose, and logged as `perenual.budget_unverified`
  (its sibling in `climate.ts` already carried `available` and fails closed).
  `perenual`'s API-key resolution used to report a throttled Parameter Store
  read as `undefined`, indistinguishable from "nobody set a key"; `pestAlerts`
  treats "unconfigured" as permanent and skipped the household's pest check for
  the day. `configurationStatus()` now answers `configured` / `unset` /
  `unavailable`, with deliberately no boolean form, and an unreadable key
  store degrades the request as a retryable upstream error.
- **`PlantDetailPage` makes one more request** for an enriched plant
  (`/species/:id` for toxicity alongside `/species/:id/guide` for the guide).
  That is the cost of decoupling a safety fact from optional prose, and it is
  the right trade: the extra call is cached for an hour and never retried.
- **More surfaces now show an error where they used to show nothing.** A
  household on a flaky connection will see "Local climate unavailable" instead
  of a clean dashboard. That is the intended change. A clean dashboard was not
  a better experience, it was a wrong one.
- **The rule is now citable.** Every one of those fixes was made without a rule
  to cite, which is a large part of why there were so many of them. The next
  reviewer points at a decision instead of re-deriving the argument from the
  particular card in front of them.
