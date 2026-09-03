# 0011 — An ungrounded pet-safety claim blocks; it is never merely `unverified`

**Status:** Accepted

**Date:** 2026-09-02

**Deciders:** Chelsea Kelly-Reif

**Extends:** [ADR 0009](0009-three-state-grounding-verdict.md) (the verdict
shape and its `unverified`-does-not-block rule stand; this record adds a second
class of recognized claim to which that rule deliberately does not apply)

## Context

"Is this plant safe for my cat?" is the highest-consequence question the
assistant is asked, and until this change it was the least protected. The
`pet-safety` eval class (#388) measured the gap rather than assuming it:

1. the RAG corpus has **0** chunks carrying any toxicity vocabulary, so
   retrieval cannot supply a verdict;
2. **0** tools in `TOOL_REGISTRY` exposed `PET_TOXICITY` — the hand-curated,
   ASPCA-grounded table the app already publishes at `GET /species/toxicity`
   — so the verified answer existed but the model could not reach it;
3. `checkGrounding` recognized only numeric claims. "Pothos is completely safe
   for cats" carries no number, so the guard returned `unverified`, which by
   ADR 0009's design does not block; and
4. `should-refuse` covered the acute case (an animal already ate something)
   but not the routine lookup, which should be _answered_ — from the table.

The three mechanisms missed in the same direction: towards a confident, wrong
"that one's fine".

ADR 0009's rule — `unverified` does not block — was made for a corpus that is
largely qualitative, where "the guard recognized nothing" usually means "a
legitimate qualitative answer". That reasoning does not transfer to a
categorical safety verdict about an animal. Here, a verified source exists, is
one tool call away, and the claim has exactly one honest provenance. An
unsupported "safe for cats" is not an answer the guard happened not to
recognize; it is an answer that skipped its source.

## Decision

- **A read-only `check_pet_toxicity` tool** answers lookups from
  `PET_TOXICITY` via the existing `lookupToxicity` matcher, unchanged and not
  loosened. A miss is returned as `status: 'not_in_checker'` — the matcher's
  honest answer — and the system prompt forbids filling that gap from memory.
  The tool reads no household data; it is pure and deterministic.
- **Categorical pet-safety claims are recognized claims.** A clause that
  asserts a plant is safe / non-toxic / harmless / fine for cats, dogs, or pets
  (and the Spanish equivalents: _seguro_, _no tóxico_, _inofensivo_ …) is
  checked like a dose. The danger direction ("toxic to cats") is not gated: a
  false alarm costs a needless scare, a false all-clear can cost an animal.
- **An ungrounded safety claim is `ungrounded`, not `unverified`, and blocks.**
  The answer is replaced with a refusal-with-pointer
  (`PET_SAFETY_BLOCK_MESSAGE`: what the assistant could not confirm, where the
  verified checker is, and the vet / ASPCA Animal Poison Control line for an
  animal that has already eaten something). This is the one place the guard
  blocks on "nothing to check": no evidence for a safety claim means the tool
  was not consulted or said "not in our checker".
- **Evidence is structured, per-species, and name-matched.** Only verdicts
  carried on a `check_pet_toxicity` result (this turn, or replayed from
  history like RAG spans) ground a safety claim. A claim about cats needs a
  `cats: non-toxic` verdict; about dogs, `dogs: non-toxic`; about "pets" or
  with no species named, both. Where the clause names a plant that appears in
  the evidence, that entry's verdict decides. Where it names none ("it's safe
  for your cat"), every evidence entry must be non-toxic for the species —
  mixed evidence with an unnamed subject blocks.
- **The safety dimension is checked even when no RAG or tool context exists.**
  The primary failure mode is the model answering without calling anything.
  The quantitative guard keeps ADR 0009's scope (RAG/tool context present).
- **Streaming is held for pet-safety turns.** Text is buffered until the
  completed answer passes when the user's message mentions pet safety or when
  a toxicity result is in context, for the same reason RAG answers are held:
  a claim that has already streamed cannot be retracted.
- **The table stays the only toxicity source.** The corpus must remain free of
  toxicity vocabulary (`petSafety.eval.test.ts` asserts the count is still 0);
  a second source is how two sources drift apart.

## Consequences

- **Hedged and negated forms are not claims.** "I can't confirm it's safe for
  cats", "not safe for dogs", "unsafe", "¿es seguro?" pass unchanged — the
  honest "not in our checker" answer must never be blocked. A short preceding
  window is scanned for negation and hedge words; a clause is the unit, so
  "toxic to cats, so it's only safe out of reach" is not a categorical safety
  claim, while "toxic to dogs but safe for cats" still is.
- **Over-blocking is bounded, not zero.** "Your cat should be fine after a
  small nibble" is a pet-safety reassurance and is blocked without a
  non-toxic verdict — that is intended. "It's safe to repot now" has no pet
  noun and is not touched. The block replaces the whole answer, so a mostly
  correct answer with one unsupported all-clear is replaced by the pointer;
  the model is instructed to state the tool's verdict and note instead.
- **This is traceability, not entailment.** A Spanish plant name does not
  match the table's English names, so a Spanish answer falls back to the
  conservative all-entries rule. A reassurance with no safety predicate and no
  pet noun ("she'll be okay") is not recognized; whether the live model
  refuses the acute case remains a live-eval question, not a guard property.
- **A residual streaming gap is disclosed.** A safety claim volunteered in an
  answer to a question that mentions no pet streams live; the persisted answer
  is still replaced, but `ChatPage.tsx` prefers the streamed text at `done`,
  so the correction does not reach the screen. Closing that is a frontend
  change outside this record.
- **Observability.** `chat_grounding_blocked` gains `blockedOn` (`safety` |
  `quantitative`) and `ungroundedSafetyClaimCount`; `claimsChecked` on all
  three events now counts safety claims alongside quantitative ones. Counts
  only, no answer text, as before.
- The `pet-safety` eval class is extended (routine toxic / non-toxic lookups,
  a plant the checker does not have, and the acute case in English and
  Spanish), and its "recorded gap" tests now assert the gap is closed: the
  tool exists, the guard blocks, and both are re-measured on every backend
  test run. Whether the live model actually calls the tool is still the
  generation-layer eval this repo has not built.
