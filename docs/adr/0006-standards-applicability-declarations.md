# 0006 — Standards applicability declarations

**Status:** Accepted (2026-07-05)

## Context

The 2026-07-05 conformance audit (`portfolio/audit-2026-07-05/family-greenhouse-AUDIT.md`) against the vendored `docs/standards/` (pinned `v1.0.1`, since #137) found that this repo scored 76/211 (~36%) not primarily because the engineering is weak — CI has 10 real gating jobs, 61/61 SHA-pinned actions, OIDC-only cloud creds — but because **nothing was declared**: no README conformance table, no ASVS level, no observability tier, no AI-evaluation applicability statement. `STANDARDS/README.md` §"How a repo declares conformance" treats silent omission as a defect in its own right, independent of the underlying engineering quality (CQ-45 / DOC-11-14 / RTF-07).

## Decision

Every one of the 11 standards gets an explicit declared state, in two places:

1. **`README.md` → `## Standards conformance`** — one row per standard, state ∈ `Applies — met` / `Applies — gap tracked` / `N/A — reason`, kept current at every release.
2. **`docs/RESPONSIBLE-TECH-AUDITS.md`** — the fuller detail: ASVS level (L2, given the PII surface), the RTF §A–F applicability block, SEC-40 §F sub-declarations, and any dated waivers (e.g. the AI-EVALUATION-STANDARD waiver while the eval harness is built out — see that doc).

Declaring "gap tracked" instead of quietly doing more than we say is the whole point: this repo already does more than it declared, and the standards treat that as equally wrong as declaring more than is done.

## Consequences

- Every future standards bump or new AWS-SDK/LLM/PII-touching dependency needs a one-line addition to the README table and (if non-trivial) a decision recorded here or in `RESPONSIBLE-TECH-AUDITS.md` — cheap, and it's the thing that was missing.
- The table will show real gaps (e.g. AI-EVALUATION at "waived, harness in progress") rather than a false "Applies — met" — that's intentional; a green table that isn't backed by evidence is worse than an honest amber one.
- Reviewers (i.e., future me) get one place to check before merging a PR that changes what a standard applies to (a new external API call, a new locale, a new LLM call) — did the declaration move too?
