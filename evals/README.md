# AI evaluation harness (starter) — family-greenhouse

This directory is the smallest **honest** starting point for
`STANDARDS/AI-EVALUATION-STANDARD.md` conformance, committed as part of the
2026-07-05 conformance-audit remediation. It is explicitly **not** a full
RAGAS/DeepEval-class harness — see
[`docs/RESPONSIBLE-TECH-AUDITS.md`](../docs/RESPONSIBLE-TECH-AUDITS.md) for
the dated waiver covering exactly what's missing and by when it needs a
real decision.

## What's here

- **`benchmark.jsonl`** — 134 items (expanded 2026-07-17 from the original 22) in four classes, each carrying `category` + `expectedBehavior`:
  - **102 `corpus` / `answer`** — real-user-phrased plant-care questions,
    8–10 per corpus article (all 11 files under
    `backend/src/data/plant-care-corpus/`), each naming the exact corpus
    chunk (`source` + `sectionTitle`) that answers it and a short list of
    `expectedFacts` (documentation for a human reviewer and the future
    generation-layer grader — not currently graded by code; see
    "Limitations").
  - **12 `should-refuse` / `refuse`** — pesticide/herbicide dosing,
    medical/veterinary triage, and plant-ID-from-text questions the system
    prompt (rules 4/6) commits the model to refusing; `notes` records what
    correct behavior looks like.
  - **10 `out-of-corpus` / `abstain`** — questions the 11-article corpus
    cannot answer (scale insects, lawn care, hydroponics, …); correct
    behavior is honest abstention, never fabrication.
  - **10 `household-data` / `answer`** — questions answerable only through
    the household tools; `expectedTools` names the `TOOL_REGISTRY` tools
    whose data supports the answer (validated against the registry so a tool
    rename breaks the build).
- **`eval-baseline.json`** — the committed baseline `backend/tests/eval/ragRetrieval.eval.test.ts`
  regresses against. Runs as part of the normal backend test suite (`npm test`
  in `backend/`, which CI's existing `test-backend` job already runs on every
  PR — no new path-filtered CI job was added; the eval is cheap, deterministic,
  and has no reason to run less often than every backend test run).
- **`../backend/src/services/chat/groundingGuard.ts`** — the citation/grounding
  guard (AIEV-12), a numeric-claim grounding heuristic, unit-tested in
  `backend/tests/unit/services/chatGroundingGuard.test.ts` and enforced by the
  live sync/stream orchestration tests. When RAG context exists, the completed
  answer is checked before persistence or delivery; unsupported quantitative
  claims are replaced, and streaming output is buffered until the check passes.

Run it directly: `npm run eval` (root) or `npm run eval --workspace backend`
— both alias to `vitest run tests/eval` in the backend workspace.

## Method — and its honest limitation

A real RAG eval sends the benchmark **query text** through the live embedding
model, retrieves, and scores the _generated answer_ against the retrieved
context (faithfulness, hallucination rate, etc. — the full `AI-EVALUATION-STANDARD.md`
§1 metric suite). Doing that here would mean calling real Bedrock
(Titan Embeddings + Claude) from CI on every PR — real AWS cost, real
network dependency, and (per this remediation's ground rules) this pass does
not execute anything against live AWS/Bedrock infrastructure.

Instead, `ragRetrieval.eval.test.ts` uses each corpus-class benchmark item's
**own anchor chunk's precomputed embedding** (already committed in
`plant-care-corpus-embeddings.json`) as a stand-in query vector. This is a
legitimate proxy for "a well-embedded query about this topic" (a real query
embedding for "how often should I water a monstera?" should land close to
the watering-basics chunk in the same 1024-dim Titan space) — it validates:

- the deterministic retrieval algorithm (cosine similarity, top-K ranking)
- corpus coverage/integrity (the expected chunk still exists — catches drift
  if a corpus article is rewritten or removed without updating the benchmark)
- a real regression gate wired into CI (`recallAt3`, `ownChunkTop1Rate`,
  per-class count floors, and a per-article question floor committed in
  `eval-baseline.json`, checked on every backend test run)

**What it does NOT validate:** live Titan query-embedding quality (does a
real user's phrasing actually land near the right chunk?), the generation
layer (faithfulness, hallucination, refusal correctness — nothing here calls
Claude), red-team/prompt-injection resistance, or per-segment (EN/ES)
breakdown (the chat is English-only today). In particular, the three
adversarial classes added 2026-07-17 are **labeled test data with structural
gates, not yet graded behavior**: whether the live model actually refuses
`should-refuse` items, abstains on `out-of-corpus` items, or calls the
expected tools on `household-data` items is exactly what the
generation-layer job below must measure. Claiming refusal coverage from
labels alone would be dishonest; we don't.

## What a real end-to-end eval needs next (tracked, not built in this pass)

1. ~~**Expand the benchmark** from 22 to the standard's target of 100–500
   questions, and add "should-refuse" cases (pesticide dosing, medical-style
   diagnosis) alongside "should-answer" ones.~~ **Done 2026-07-17** — 134
   items across four behavior classes (see "What's here"). The labels are
   in place; grading them is steps 2–3.
2. **A live-embedding smoke run** — a manually-triggered (not per-PR) job that
   calls real Titan + Claude against the benchmark and scores faithfulness /
   hallucination / refusal, gated behind an AWS credential and a cost budget,
   with results committed to `docs/audits/eval-run.json`.
3. **Promptfoo OWASP LLM01–10 red-team scan** and a **Garak baseline** —
   neither exists yet (§2 of the standard).
4. **Judge calibration** — N/A today (no LLM-as-judge is in use); revisit if
   one is introduced.
5. Expand beyond the live numeric-token guard to semantic entailment for
   qualitative care claims. That requires a calibrated scorer or equivalent
   evidence; the current deterministic guard deliberately does not pretend to
   measure it.

See the dated waiver in `docs/RESPONSIBLE-TECH-AUDITS.md` for the owner and
expiry on closing this list.
