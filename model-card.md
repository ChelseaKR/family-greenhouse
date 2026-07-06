---
language: en
license: other
base_model: anthropic/claude-haiku-4-5 (Bedrock-hosted; configurable — see "Model identity" below)
pipeline_tag: conversational
library_name: aws-sdk-bedrock-runtime
model-index:
  - name: family-greenhouse-plant-care-rag
    results:
      - task:
          type: retrieval
          name: RAG retrieval (plant-care corpus)
        dataset:
          name: family-greenhouse starter benchmark
          type: evals/benchmark.jsonl
        metrics:
          - type: recall@3
            value: 1.0
          - type: own-chunk-top-1-rate
            value: 1.0
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
- **Fabricated numeric care claims** (mitigated by a new, narrow guard, not
  yet enforced live): `backend/src/services/chat/groundingGuard.ts` can
  detect a numeric/quantitative claim (a percentage, a frequency, a duration)
  with no support in the retrieved RAG spans. It is unit-tested
  (`chatGroundingGuard.test.ts`) but **not yet wired as a hard block** into
  the live `turnEvents()` response path — see the eval-harness waiver in
  `docs/RESPONSIBLE-TECH-AUDITS.md` for why, and what wiring it live would
  require (a product decision on what happens to a flagged turn, not just a
  code change).
- **No live faithfulness/hallucination/refusal scoring** — this repo has not
  run the model against a benchmark and measured its actual answer quality;
  the eval-baseline in `evals/eval-baseline.json` measures retrieval-ranking
  correctness only (see `evals/README.md` "Method — and its honest
  limitation"). This is the single largest gap this card exists to disclose.
- **Tool-use loop divergence, mitigated:** per-turn tool-call cap of 5
  (`MAX_TOOL_CALLS_PER_TURN`), unit-tested.
- **Cost/budget runaway, mitigated:** atomic per-household monthly token
  budget with a reservation gate that serializes concurrent turns
  (`RESERVE_INPUT_TOKENS`/`RESERVE_OUTPUT_TOKENS`, #136).

## Eval results

See [`evals/README.md`](evals/README.md) and
[`evals/eval-baseline.json`](evals/eval-baseline.json). Current state:
retrieval recall@3 = 1.0 and own-chunk top-1 rate = 1.0 against a 22-question
starter benchmark (target per `AI-EVALUATION-STANDARD.md`: 100–500 questions
with live faithfulness/hallucination/refusal scoring — not yet built, see the
dated waiver in `docs/RESPONSIBLE-TECH-AUDITS.md`).

## Guardrails already in place (architecture, not evaluation — credit where due)

- Read-only tool catalog for the "tight integration" data (plants/tasks/
  climate); the only write-adjacent tool (`propose_reminder_task`) requires
  explicit user confirmation.
- Per-household token budget with atomic reservation.
- UUID validation rejecting a hallucinated plant ID before any tool executes
  on it (`chat/index.ts:433` equivalent — the server re-looks-up by name
  rather than trusting the model's raw ID).
- PII-redacted tool payloads before anything reaches Bedrock (`chat/tools.ts`
  strips emails, Cognito subs, `createdBy` fields).
- Cross-household isolation enforced at the tool layer (every tool call is
  scoped by the caller's own `householdId`, never by tool input).

## Environmental / compute footprint

N/A — API-only usage of a third-party hosted model; no training or
fine-tuning run happens in this repo (AIEV-23/24 N/A, per the governance
declaration in `docs/RESPONSIBLE-TECH-AUDITS.md`).

## Review

- **Card owner:** Chelsea Kelly-Reif.
- **Last reviewed:** 2026-07-05 (first version).
- **Recheck cadence:** on any model-ID change, prompt rewrite, or new tool
  added to `TOOL_REGISTRY`; at minimum quarterly alongside
  `docs/RESPONSIBLE-TECH-AUDITS.md`.
