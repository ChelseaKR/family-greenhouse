# 0008 — Unit-aware quantitative grounding for RAG answers

**Status:** Accepted

**Date:** 2026-08-09

**Deciders:** Chelsea Kelly-Reif

## Context

The chat grounding guard originally recognized frequencies, percentages,
temperatures, durations, and lengths, then checked whether each recognized
number appeared somewhere in the retrieved care corpus. That left the guard
blind to dosing and dilution claims such as `1 tsp per gallon`, fertilizer
ratios such as `10-10-10`, and repetitions such as `3-4 times the pot's
volume`. It also meant a dose could borrow an unrelated occurrence of the same
number from another sentence. A successful check with zero recognized claims
produced no telemetry, so operators could not distinguish a substantive pass
from a vacuous one.

This is a hard AI guardrail: unsupported recognized quantitative claims are
replaced before persistence or delivery, including on the buffered streaming
path. Changing its scope therefore requires an explicit decision record.

## Decision

- Recognize care-relevant volume, mass, dose, dilution, `times`/`parts`, colon
  ratios, slash-form dose denominators, and three-part NPK ratios in addition
  to the existing quantitative forms.
- Match safety-sensitive evidence as canonical number-and-unit tokens. For
  doses written with `per` or `/`, include the denominator amount and unit so
  `1 tsp per gallon` cannot support `1 tsp per cup`.
- Continue to fail closed: if any recognized quantitative token lacks matching
  retrieved evidence, replace the completed answer with the existing safe
  verification message before it is stored or shown.
- Emit `chat_grounding_checked` for successful RAG checks with only
  `claimsChecked` and `sourceCount`. A zero-claim pass is allowed but is now
  explicitly observable. Claim text and source text remain excluded from logs.
- Keep the guard's scope precise: it is a deterministic quantitative heuristic
  for RAG answers, not a semantic factuality or qualitative-entailment check.

## Consequences

- Fabricated dosing, dilution, repetition, and fertilizer-ratio claims are no
  longer silently treated as having no claims to check.
- Unit-aware matching may block some valid paraphrases that use an unsupported
  alias. The safe replacement is preferable to delivering an unsupported dose;
  aliases must be added with positive and negative regression tests.
- Operators can measure how often the guard performs a substantive check versus
  a zero-claim pass without logging user or corpus content.
- Qualitative claims and unrecognized quantitative phrasing remain outside this
  mechanical control. Live faithfulness, hallucination, and refusal scoring
  remain covered by the dated AI-evaluation waiver.
