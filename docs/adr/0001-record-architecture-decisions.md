# 0001 — Record architecture decisions

**Status:** Accepted (2026-06-10)

## Context
Significant decisions (storage model, auth, deferrals, a reversal like the WAF) were captured only in commit messages, inline comments, and review docs — scattered and easy to lose. New contributors (and future-us) re-litigate settled questions.

## Decision
Keep lightweight ADRs in `docs/adr/`, one file per decision, numbered. Capture Context / Decision / Consequences. Write one for non-obvious choices and for anything someone might reasonably try to reverse.

## Consequences
- A durable, greppable trail of *why*.
- Small per-decision overhead; we only write them for decisions that warrant it.
- Backfilling old decisions is best-effort, done when the area is next touched.
