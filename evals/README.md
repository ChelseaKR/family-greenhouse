# AI evaluation harness (starter) — family-greenhouse

This directory is the smallest **honest** starting point for
`STANDARDS/AI-EVALUATION-STANDARD.md` conformance, committed as part of the
2026-07-05 conformance-audit remediation. It is explicitly **not** a full
RAGAS/DeepEval-class harness — see
[`docs/RESPONSIBLE-TECH-AUDITS.md`](../docs/RESPONSIBLE-TECH-AUDITS.md) for
the dated waiver covering exactly what's missing and by when it needs a
real decision.

## What's here

- **`benchmark.jsonl`** — 22 plant-care questions, one or two per corpus
  article (all 11 files under `backend/src/data/plant-care-corpus/`), each
  naming the exact corpus chunk (`source` + `sectionTitle`) that answers it
  and a short list of `expectedFacts` (documentation for a human reviewer —
  not currently graded by code; see "Limitations").
- **`eval-baseline.json`** — the committed baseline `backend/tests/eval/ragRetrieval.eval.test.ts`
  regresses against. Runs as part of the normal backend test suite (`npm test`
  in `backend/`, which CI's existing `test-backend` job already runs on every
  PR — no new path-filtered CI job was added; the eval is cheap, deterministic,
  and has no reason to run less often than every backend test run).
- **`../backend/src/services/chat/groundingGuard.ts`** — the citation/grounding
  guard (AIEV-12), a numeric-claim grounding heuristic, unit-tested in
  `backend/tests/unit/services/chatGroundingGuard.test.ts`.

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

Instead, `ragRetrieval.eval.test.ts` uses each benchmark item's **own anchor
chunk's precomputed embedding** (already committed in
`plant-care-corpus-embeddings.json`) as a stand-in query vector. This is a
legitimate proxy for "a well-embedded query about this topic" (a real query
embedding for "how often should I water a monstera?" should land close to
the watering-basics chunk in the same 1024-dim Titan space) — it validates:

- the deterministic retrieval algorithm (cosine similarity, top-K ranking)
- corpus coverage/integrity (the expected chunk still exists — catches drift
  if a corpus article is rewritten or removed without updating the benchmark)
- a real regression gate wired into CI (`recallAt3`, `ownChunkTop1Rate`
  committed in `eval-baseline.json`, checked on every backend test run)

**What it does NOT validate:** live Titan query-embedding quality (does a
real user's phrasing actually land near the right chunk?), the generation
layer (faithfulness, hallucination, refusal correctness — nothing here calls
Claude), red-team/prompt-injection resistance, or per-segment (EN/ES)
breakdown (the chat is English-only today).

## What a real end-to-end eval needs next (tracked, not built in this pass)

1. **Expand the benchmark** from 22 to the standard's target of 100–500
   questions, and add "should-refuse" cases (pesticide dosing, medical-style
   diagnosis) alongside "should-answer" ones.
2. **A live-embedding smoke run** — a manually-triggered (not per-PR) job that
   calls real Titan + Claude against the benchmark and scores faithfulness /
   hallucination / refusal, gated behind an AWS credential and a cost budget,
   with results committed to `docs/audits/eval-run.json`.
3. **Promptfoo OWASP LLM01–10 red-team scan** and a **Garak baseline** —
   neither exists yet (§2 of the standard).
4. **Judge calibration** — N/A today (no LLM-as-judge is in use); revisit if
   one is introduced.
5. Wire `groundingGuard.checkGrounding()` into the live `turnEvents()` RAG
   path (currently unit-tested but not called from production code) once
   there's a plan for what to do on a detected ungrounded claim (regenerate?
   append a disclaimer? log-only?) — a product decision, not just a code change.

See the dated waiver in `docs/RESPONSIBLE-TECH-AUDITS.md` for the owner and
expiry on closing this list.
