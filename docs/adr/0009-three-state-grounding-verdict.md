# 0009 — The grounding guard reports a three-state verdict, not a boolean

**Status:** Accepted

**Date:** 2026-08-15

**Deciders:** Chelsea Kelly-Reif

**Amends:** [ADR 0008](0008-unit-aware-rag-grounding.md) (the reporting bullet only; its
recognition and evidence-matching decisions stand)

## Context

`checkGrounding` returned `grounded: boolean`, computed as "no recognized claim
was contradicted". [ADR 0008](0008-unit-aware-rag-grounding.md) widened what
counts as a recognized claim but kept that boolean, and kept the behaviour it
implies: an answer in which the guard recognized nothing was reported
`grounded: true` with `claimsChecked: []`.

That value is read as a verification. `docs/RESPONSIBLE-TECH-AUDITS.md` §D
cites the guard as the AUTO-GATE behind the transparency commitment, and
`docs/audits/ai-risk-register.md` cites it as a confabulation mitigation. In
both places the reader takes `grounded` to mean the answer's quantitative
claims were traced to the corpus. For a zero-claim answer that is not what
happened: nothing was traced, because nothing was recognized.

A guard that reports success having checked nothing is worse than no guard,
because the success is the part that gets trusted. The unit test suite had
pinned the behaviour as the specification — `it('is vacuously grounded when the
answer makes no quantitative claim')` asserted exactly the false signal — so
the defect was green for its whole life.

Two shapes of answer produce a zero-claim result, and they are not the same:

1. no numeric content at all (a qualitative answer — the documented,
   deliberate limit of a deterministic heuristic); and
2. numeric content that fits no checkable claim shape ("I compared 3
   fertilizers"). Here the guard has seen a number and cannot say anything
   about it.

The second is the shape that hid the dose blind spot fixed in #307: before
that fix, `3 tsp per gallon` was case 2, and the boolean called it clean.

## Decision

- Replace `grounded: boolean` with `verdict: 'verified' | 'unverified' |
'ungrounded'`. The boolean is **removed**, not deprecated: while it exists,
  the false signal is representable, and a future caller can reintroduce the
  bug by reading it.
  - `verified` — at least one claim was checked, every one is supported, and
    no numeric content was left unclassified.
  - `unverified` — the guard checked nothing it can vouch for. It makes no
    assertion about the answer, positive or negative.
  - `ungrounded` — a recognized claim is contradicted by (or absent from) the
    retrieved spans.
- `isBlockingVerdict()` is the single delivery decision, and only `ungrounded`
  blocks. Callers cannot accidentally block on "unverified" or pass on it by
  reading a field that mixes the two.
- Report unclassified numeric content explicitly
  (`unclassifiedNumericSentences`), and let it demote an otherwise-verified
  answer to `unverified`. Partial verification is not verification.
- Recognize word-quantity dose claims (`half strength`, `double the dose`,
  `twice the concentration`) as checkable claims matched against the same
  retrieved spans. The corpus gives its highest-consequence instruction in
  words — "at half the recommended strength" (`fertilizing.md:7`), "quarter
  strength" (`:8`) — so a digit-only guard is still blind to dilution.
- Log the three states under three event names: `chat_grounding_checked`
  (verified only), `chat_grounding_unverified`, `chat_grounding_blocked`.
  Counts only; no answer or source text, as before.

## Consequences

- **`unverified` does not block.** Blocking it would replace every qualitative
  answer with the verification message, and the corpus is largely qualitative.
  The cost of that choice is explicit: an unverified answer reaches the user,
  and nothing in the product claims it was checked. The counter-argument —
  that a RAG answer carrying an unclassifiable number deserves the safe
  message — is real, and `chat_grounding_unverified`'s
  `unclassifiedNumericCount` is the measurement that would settle it. This
  ADR records that the data does not exist yet, not that the question was
  answered.
- The pass rate the docs can honestly claim drops: answers previously counted
  as grounded are now split into verified and unverified. That is a reporting
  correction, not a regression, and the affected doc claims were corrected in
  the same change.
- Word-quantity dose matching is traceability, not entailment: the corpus
  contains "full strength" (in a sentence advising _against_ it), so an answer
  recommending full strength is `verified`. The guard has never claimed to
  check whether the corpus endorses a quantity, only that the corpus contains
  it. Semantic entailment remains under the dated AI-evaluation waiver.
- `GroundingResult` is internal to the backend chat service; no API response
  or client contract changes.
