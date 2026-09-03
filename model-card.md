---
language: en
license: other
base_model: anthropic/claude-haiku-4-5 (Bedrock-hosted; configurable — see "Model identity" below)
pipeline_tag: conversational
library_name: aws-sdk-bedrock-runtime
model-index:
  # These are NOT retrieval-quality results. Nothing in this repo has ever
  # embedded a benchmark question with the live embedding model; the eval
  # feeds each corpus chunk's own precomputed vector back in as the query, so
  # a perfect score is arithmetic, not performance (cosine(x, x) = 1 is the
  # maximum possible similarity, so the target chunk cannot rank anywhere but
  # first). The metric ids below say so, because a machine reading this
  # front-matter will not read the narrative underneath it. The caveat in
  # evals/eval-baseline.json ("method") is the source of truth.
  - name: family-greenhouse-plant-care-rag
    results:
      - task:
          type: retrieval
          name: >-
            Corpus-integrity sanity check (anchor-chunk self-retrieval). Not a
            measure of retrieval quality on real user queries; no live query
            embedding is computed anywhere in this eval.
        dataset:
          name: >-
            family-greenhouse starter benchmark, 147 items; only the 102
            corpus-class items are scored here. The 45 adversarial items
            (should-refuse / out-of-corpus / household-data / pet-safety)
            are schema- and count-gated but not behaviourally graded. The
            13 pet-safety items additionally have their expected cats/dogs
            verdicts hard-gated against the curated ASPCA-grounded table in
            backend/src/models/petToxicity.ts, so benchmark and table cannot
            drift apart — but whether the live assistant returns that verdict
            is still ungraded, and evals/eval-baseline.json records the three
            measured reasons it could get one wrong unchecked (no toxicity
            content in the RAG corpus, no chat tool exposing the table, and a
            grounding guard that only recognises numeric claims).
          type: evals/benchmark.jsonl
        metrics:
          # eval-baseline.json calls this field recallAt3.
          - type: anchor-chunk-self-retrieval-at-3
            value: 1.0
            name: >-
              1.0 by construction. Query vector IS the target chunk's
              embedding, so the target is always in the top 3. Below 1.0 would
              mean the corpus or the ranking code broke, not that retrieval
              quality dropped.
            verified: false
          # eval-baseline.json calls this field ownChunkTop1Rate. The check
          # compares the top hit's source ARTICLE, not the chunk itself, so
          # the field name is looser than it sounds; measured 2026-08-15, the
          # strict chunk-level rate is also 1.0, for the same reason.
          - type: anchor-article-rank-1-rate
            value: 1.0
            name: >-
              1.0 by construction, same cause. A sanity floor on ranking and
              corpus integrity, not an accuracy figure.
            verified: false
---

# Model card — Family Greenhouse plant-care assistant

Committed per `STANDARDS/AI-EVALUATION-STANDARD.md` §4 and
`RESPONSIBLE-TECH-FRAMEWORK.md` §D (transparency). This is the first model
card this repo has ever had — see `docs/RESPONSIBLE-TECH-AUDITS.md` for the
full AIEV-01 waiver this card is part of satisfying.

## What's covered

Two features call the same Bedrock endpoint family:

1. **Plant-care chat** (`backend/src/services/chat/`) — tool-use + RAG
   conversational assistant, docs in `docs/chat-rag-design.md`.
2. **Leaf-health check** (`backend/src/services/leafHealth.ts`) — a single-photo
   vision call that classifies visible leaf condition (cosmetic-grade only).

Both are gated behind `BEDROCK_CHAT_MODEL_ID` and share the same underlying
transport (`InvokeModel` against the Anthropic Messages API shape on Bedrock).

## Model identity — a discrepancy worth stating plainly

`docs/chat-rag-design.md` (2026-05-31) specifies **Claude Sonnet 4.6** as the
intended chat model. The **actual code default**, unchanged since the
feature shipped and with no Terraform override in any environment's tfvars
(`infrastructure/environments/{staging,production}/terraform.tfvars` — neither
sets `bedrock_chat_model_id`), is:

```
us.anthropic.claude-haiku-4-5-20251001-v1:0   (backend/src/services/chat/bedrock.ts:27,
                                                backend/src/services/leafHealth.ts:35)
```

So **production is running Haiku 4.5, not Sonnet 4.6**, and has been since
launch — a cheaper, faster model than the one the design doc, the system
prompt's cost comments, and (implicitly) any stakeholder reading the design
doc would assume. This is not necessarily wrong (Haiku 4.5 may well be
sufficient for tool-use Q&A, and it's ~3x cheaper), but it is exactly the
kind of silent model-identity drift a model card exists to catch — a model
swap with no gate would otherwise be invisible, per the original audit
finding. **Action for the maintainer:** either update `chat-rag-design.md` to
reflect Haiku 4.5 as the intentional choice, or set
`var.bedrock_chat_model_id` to a Sonnet inference profile in the environments
that should run it. This card does not make that call — it surfaces it.

- **Chat model:** configurable via `BEDROCK_CHAT_MODEL_ID`. Current default /
  actual production value: `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- **Embedding model:** `amazon.titan-embed-text-v2:0` (1024 dimensions),
  configurable via `BEDROCK_EMBED_MODEL_ID`.
- **Leaf-health model:** same `BEDROCK_CHAT_MODEL_ID` value (shared env var).
- **Region:** `us-east-1` (both features; no cross-region routing).
- **Provider:** AWS Bedrock, in-account, in-region, excluded from Anthropic/AWS
  model-training data per Bedrock's data-handling policy (per
  `chat-rag-design.md` "Privacy").

## Intended use

- A household-scoped plant-care Q&A assistant that reasons over **the user's
  own plants, tasks, and local climate** (via read-only tools) plus a curated
  11-article plant-care knowledge corpus (via RAG).
- A single-photo, cosmetic-grade leaf-condition check (yellowing, browning,
  wilting, spots, visible pests) — explicitly not a diagnosis.

## Out-of-scope use (explicit non-goals)

- **Not medical or diagnostic advice** — leaf-health is "cosmetic visual check
  from a single photo," stated in the model's own required disclaimer field
  (`leafHealth.ts` `assessmentSchema.disclaimer`).
- **Not pesticide/herbicide/fertilizer dosing guidance** beyond what a major
  nursery website would publish — the chat system prompt hard-refuses this
  class of question and redirects to "consult the product label or your
  local extension office" (`chat/index.ts` `SYSTEM_PROMPT` rule 4).
- **Not plant identification from a text description** — the system prompt
  explicitly refuses to invent an ID from a description and redirects to the
  photo-based Add Plant flow (rule 6).
- **Never a direct-write agent** — the model can only _propose_ a reminder
  task via `propose_reminder_task`; the user must confirm via a UI card
  before any `POST /tasks` write happens (rule 7, and see the AUTO-GATE
  tests in `backend/tests/unit/services/chatTurn.test.ts`).
- **Not multi-household or cross-tenant** — every tool call is scoped to the
  caller's own `householdId`; see the BOLA/cross-household isolation tests
  (`backend/tests/integration/local-server.test.ts:1526`).

## Known failure modes

- **Missing-data-as-false-answer** (fixed, cited for the record): the species
  integration previously let missing Perenual data read as "no watering
  needed" instead of "we don't know" — fixed in #170 and swept for the same
  bug class across the integration in #171. The grounding guard added in this
  remediation pass (`groundingGuard.ts`) generalizes the same principle to
  chat RAG answers: a claim not backed by retrieved data should be flagged,
  not asserted.
- **Fabricated numeric care claims** (mitigated by a narrow live guard):
  `backend/src/services/chat/groundingGuard.ts` flags a quantitative claim (a
  percentage, frequency, temperature, duration, length, volume, mass,
  dose/dilution, `times`/`parts` repetition, fertilizer ratio, or a
  word-quantity dose such as "half strength") unless every numeric token and
  canonical dose token in it occurs in the retrieved RAG spans. `turnEvents()`
  replaces a failed answer with a safe verification message before persistence
  or delivery; streaming RAG text is buffered until the same check passes.
  Sync, streaming, and mixed-supported/unsupported-number cases are regression
  tested. Qualitative entailment remains outside this heuristic.
- **Answers the guard cannot check** (disclosed, not mitigated): the guard
  reports `verified` / `unverified` / `ungrounded`, and an answer in which it
  recognized no checkable claim — or which carries numeric content fitting no
  claim shape — is `unverified` and still delivered. `unverified` is not a
  pass: it means nothing in that answer was checked. Do not read the guard's
  presence as coverage of every delivered answer
  (`docs/adr/0009-three-state-grounding-verdict.md`).
- **No live faithfulness/hallucination/refusal scoring** — this repo has not
  run the model against a benchmark and measured its actual answer quality.
  The eval-baseline in `evals/eval-baseline.json` is a corpus-integrity and
  ranking-code sanity floor whose two figures are 1.0 by construction (see
  "Eval results" below and `evals/README.md` "Method — and its honest
  limitation"); it is not a retrieval-quality measurement either. This is the
  single largest gap this card exists to disclose.
- **Tool-use loop divergence, mitigated:** per-turn tool-call cap of 5
  (`MAX_TOOL_CALLS_PER_TURN`), unit-tested.
- **Cost/budget runaway, mitigated:** atomic per-household monthly token
  budget with a reservation gate that serializes concurrent turns
  (`RESERVE_INPUT_TOKENS`/`RESERVE_OUTPUT_TOKENS`, #136).

## Eval results

**Nothing on this card is a measurement of answer quality, and the two
numbers that look like retrieval scores are 1.0 by construction.** Read this
section before quoting either of them.

See [`evals/README.md`](evals/README.md) and
[`evals/eval-baseline.json`](evals/eval-baseline.json).

| Reported           | Value | What it actually is                                                                                                              |
| ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `recallAt3`        | 1.0   | Fraction of scored items whose expected source article appears in the top 3. **1.0 by construction.**                            |
| `ownChunkTop1Rate` | 1.0   | Fraction where the anchor ranks first. **1.0 by construction.** Compares the top hit's source _article_, despite the field name. |

Why "by construction": `backend/tests/eval/ragRetrieval.eval.test.ts` does not
embed the benchmark question. It takes the corpus chunk that the question is
anchored to and feeds _that chunk's own precomputed Titan vector_ back in as
the query. Cosine similarity of a vector with itself is 1, the maximum
possible score, so the anchor chunk cannot rank anywhere but first and its
article cannot be absent from the top 3. Both figures are therefore a sanity
floor on corpus integrity and the ranking code — they catch a corpus article
being rewritten or removed out from under the benchmark, which is worth
having — and they say nothing whatsoever about whether a real user's phrasing
lands on the right chunk. `eval-baseline.json`'s `method` field has always
said this; until 2026-08-15 the caveat did not travel to this card, which
published the two 1.0s in machine-readable `model-index` front-matter as
though they were results.

Scope of the run (verified 2026-09-02 against the committed benchmark and
corpus): `evals/benchmark.jsonl` holds **147 items**, of which the **102
corpus-class items** are the only ones scored; the other 45
(`should-refuse` / `out-of-corpus` / `household-data` / `pet-safety`) are
schema-validated and count-gated but not behaviourally graded, because
grading them requires the live generation-layer job that does not exist yet.
The corpus is 74 chunks across 11 articles.

The `pet-safety` class (13 items, added 2026-09-02) is the one place where
this card can say something stronger than "labelled but ungraded". Its
expected cats/dogs verdicts are hard-gated against
`backend/src/models/petToxicity.ts` — the hand-curated, ASPCA-grounded table
the app already publishes at `GET /species/toxicity` — so the benchmark and
that table cannot drift apart in either direction without failing the build.
What is still ungraded is whether the live assistant returns that verdict,
and `evals/eval-baseline.json` now records three measured reasons a wrong
verdict would pass unchallenged today: the RAG corpus contains **0** chunks
with any toxicity vocabulary, **0** tools in `TOOL_REGISTRY` expose the
curated table to the model, and `checkGrounding` returns `unverified`
(explicitly non-blocking, per ADR 0009) for a purely qualitative safety
claim, because it only recognises numeric claims. Those three numbers are
re-measured on every backend test run. The card said "22-question" until 2026-08-15: that
was the original benchmark size, and the claim went stale on 2026-07-17 when
the benchmark was expanded, four days after this card's previous review date.

Target per `AI-EVALUATION-STANDARD.md`: 100–500 questions with live
faithfulness / hallucination / refusal scoring. The question count is now met;
the scoring is not built. See the dated waiver in
`docs/RESPONSIBLE-TECH-AUDITS.md`.

## Guardrails already in place (architecture, not evaluation — credit where due)

- Read-only tool catalog for the "tight integration" data (plants/tasks/
  climate); the only write-adjacent tool (`propose_reminder_task`) requires
  explicit user confirmation.
- Per-household token budget with atomic reservation.
- UUID validation rejecting a hallucinated plant ID before any tool executes
  on it (`chat/index.ts:433` equivalent — the server re-looks-up by name
  rather than trusting the model's raw ID).
- PII-redacted tool payloads before anything reaches Bedrock: the centralized
  recursive sanitizer in `chat/tools.ts` strips member/contact/tenant/creator
  fields from live tool results and from persisted-history replay, with a
  nested-field regression test. Tool failures do not forward or log raw
  exception messages.
- Cross-household isolation enforced at the tool layer (every tool call is
  scoped by the caller's own `householdId`, never by tool input).

## Environmental / compute footprint

N/A — API-only usage of a third-party hosted model; no training or
fine-tuning run happens in this repo (AIEV-23/24 N/A, per the governance
declaration in `docs/RESPONSIBLE-TECH-AUDITS.md`).

## Review

- **Card owner:** Chelsea Kelly-Reif.
- **Last reviewed:** 2026-08-15 (first version 2026-07-05; live controls
  re-verified 2026-07-13; eval-results section and `model-index` front-matter
  corrected 2026-08-15).
- **Recheck cadence:** on any model-ID change, prompt rewrite, new tool added
  to `TOOL_REGISTRY`, **or any change to `evals/benchmark.jsonl` or
  `evals/eval-baseline.json`**; at minimum quarterly alongside
  `docs/RESPONSIBLE-TECH-AUDITS.md`. The benchmark-change trigger is new: the
  2026-07-17 expansion from 22 to 134 items did not update this card, and the
  stale count survived here for a month.
