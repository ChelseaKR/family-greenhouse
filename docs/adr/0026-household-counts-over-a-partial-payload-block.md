# 0026 — An answer may not count a household it was only partly given

**Status:** Accepted

**Date:** 2026-09-05

**Deciders:** Chelsea Kelly-Reif

**Extends:** [ADR 0009](0009-three-state-grounding-verdict.md) (the verdict
shape and its `unverified`-does-not-block rule stand) and
[ADR 0011](0011-categorical-pet-safety-claims-block.md) (a second class of
recognized claim that blocks). This is the third class, and the first whose
evidence is not a corpus span but our own count of the household.

## Context

`buildSproutContext` (`backend/src/services/sprout.ts`) builds the only payload
permitted to cross into Sprout, and it reduces the household twice: a privacy
FILTER (only a server-resolved `canonicalSpecies` may cross, so a plant that has
never been species-matched is dropped outright — for a typical household, most
of them) and then a CAP (`SPROUT_CONTEXT_CAP`, 100). ADR 0010 names that
`.slice(0, n)` as a deliberate exclusion from the `reads:check` gate: `.slice`
has no syntactic tell separating a considered "top ten" from a silent cap, so
no ratchet covers it and none is going to.

#570 made the reductions visible — every request now carries a `coverage` block
(`total`, `included`, `unmatched`, `truncated`, `cap`, `complete`, per set) —
and #579 carried it through the turn to the persisted record and the browser.
Neither decided what an answer may then ASSERT, and both said so. That is this
record.

Left undecided, the failure is the sharpest form of ADR 0010's defect. "How many
plants do I have?" and "do I have anything toxic to my cat?" are answered from
the species-matched, capped subset, in prose, by a language model, and the
household observations that come back are stamped `provenance: 'household'`. A
wrong care tip carries something a reader can weigh; a wrong count carries
nothing at all. And the plants missing from the payload are the unmatched ones —
precisely the unidentified plant somebody is asking about.

## Decision

- **A count or totality claim about the user's own collection is a recognized
  claim.** `checkHouseholdClaims` (`chat/groundingGuard.ts`) recognizes a
  number or a universal quantifier attached to a household noun (plants, tasks,
  collection, and the Spanish forms) in a sentence that refers to the user's own
  collection. Conditionals ("if any of your plants…") and questions are not
  claims, on the hedge rules ADR 0011 already established.
- **Its evidence is our coverage, not the reply.** A claim is unsupported when
  the set it counts over is not `complete`. The household total is Family
  Greenhouse's own count, sent in the payload, so a reply cannot vouch for its
  own reach.
- **An unsupported claim blocks**, and the answer is replaced by
  `HOUSEHOLD_COVERAGE_BLOCK_COPY` in the language of the question — a
  refusal-with-pointer, like ADR 0011's: the complete count is in the user's
  plant list, and matching a plant to a species is what brings it into these
  answers. The citations and Sprout's disclosure go with the withheld answer;
  the `coverage` block stays, because it is the reason for the refusal.
- **One exception, and only for counts: a stated denominator.** "Of your 112
  plants, 40 have a confirmed species" is supported, because the sentence
  carries the household total we sent. This is what #549 meant by "say what the
  number is of". A TOTALITY claim gets no such exception — "none of your 112
  plants are toxic" asserts something about 112 plants from 40.
- **The cap is not raised here.** Enlarging it would move the boundary at which
  the same silent failure happens, which is why #549 argued for making the
  truncation visible instead. Whether 100 stays is still a separate call.

## Consequences

- **Over-blocking is bounded and real.** A care generality phrased as a claim
  about the whole household ("all your plants will want more light in winter")
  is a totality claim by this test and is blocked while coverage is partial. The
  claim shape is recognizable; the intent behind it is not. Coverage is partial
  for most households today, so this is not a rare path — which is the argument
  for Sprout stating denominators, not for a looser guard.
- **The gap in the other direction is a trailing quantifier** ("your plants are
  all fine"), which is not matched. The guard is a heuristic over claim shapes,
  like the other two dimensions, not an entailment check.
- **Observability.** `chat_grounding_blocked` gains a third `blockedOn` value,
  `household-coverage`, with `householdClaimsChecked` and
  `unsupportedHouseholdClaimCount`; the `chat.message_sent` audit line gains
  `householdCoverageBlocked`, and its `citationCount` / `disclosed` now describe
  what was DELIVERED. Counts only, never claim text: an answer quotes the
  household back.
- **Sprout's own policy is unchanged and unneeded.** The service may hedge or
  state a denominator on its side; this holds whether or not it does, and holds
  the same way for any future answering service, because the check is on the
  boundary we own.
- The protection here is a payload contract and a guard a reader can check, not
  a lint rule — ADR 0010's point about `.slice` still stands.
