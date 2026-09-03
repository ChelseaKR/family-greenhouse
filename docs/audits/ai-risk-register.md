# AI risk register — family-greenhouse

Per `STANDARDS/RESPONSIBLE-TECH-FRAMEWORK.md` "Governance scaffolding for AI systems" (NIST AI RMF **MAP** function). Seeded from `docs/chat-rag-design.md`'s non-goals and open-risks sections plus the tool-guard threat notes already in the codebase — this is a consolidation of existing, real design decisions into the register format the standard requires, not new analysis invented for this document.

**Owner:** Chelsea Kelly-Reif. **Reviewed:** 2026-09-02 (first version 2026-07-05; quantitative grounding scope and observability re-verified 2026-08-09; `check_pet_toxicity` tool + categorical pet-safety guard added 2026-09-02, ADR 0011). **Recheck cadence:** quarterly, and immediately on any new tool added to `TOOL_REGISTRY`, a system-prompt rewrite, a grounding-guard change, or a model swap.

---

## AI system inventory

| System                           | Where                                | Model                                                                                     | Status                                      |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| Plant-care chat (tool-use + RAG) | `backend/src/services/chat/`         | Bedrock, `BEDROCK_CHAT_MODEL_ID` (default/actual: Claude Haiku 4.5) + Titan Embeddings v2 | Production, gated behind Garden-plan-and-up |
| Leaf-health check                | `backend/src/services/leafHealth.ts` | Bedrock, same `BEDROCK_CHAT_MODEL_ID`                                                     | Production                                  |

## Risk assessment (NIST AI 600-1 GenAI risk taxonomy — 12 categories, only applicable ones detailed)

| NIST AI 600-1 risk                                              | Applies? | Assessment                                                                                                 |
| --------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| CBRN information                                                | No       | Plant-care domain; no path to CBRN-relevant content                                                        |
| Confabulation (hallucination)                                   | **Yes**  | Primary risk. See "Confabulation" below                                                                    |
| Dangerous/violent/hateful/obscene content                       | No       | Domain-constrained (plant care); system prompt has no persona/roleplay surface that invites this           |
| Data privacy                                                    | **Yes**  | See "Data privacy" below                                                                                   |
| Environmental                                                   | N/A      | No training/fine-tuning; API-only usage (AIEV-23/24 N/A)                                                   |
| Harmful bias & homogenization                                   | Low      | No ranking/classification of people; see `RESPONSIBLE-TECH-AUDITS.md` §B                                   |
| Human-AI configuration (over-reliance, automation bias)         | **Yes**  | See "Over-reliance" below                                                                                  |
| Information integrity (misinformation at scale)                 | Low      | Single-user-facing responses, not published/broadcast content                                              |
| Information security (prompt injection, jailbreak, tool misuse) | **Yes**  | See "Information security" below                                                                           |
| Intellectual property                                           | Low      | RAG corpus is originally authored (`backend/src/data/plant-care-corpus/`), not scraped third-party content |
| Obscene/degrading content                                       | No       | Same as violent/hateful above                                                                              |
| Value-chain / component integration risks                       | **Yes**  | See "Value chain" below                                                                                    |

### Confabulation

**Risk:** the model states a specific, wrong care fact (a watering frequency, a humidity threshold) with unwarranted confidence — the historical pattern that produced real bugs (#170, #171: missing Perenual data read as "no watering needed").

**Mitigations today:**

- Tool-use architecture: for anything about the user's _own_ plants, the model must call a tool rather than guess — the tool result, not the model's prior, is the source of truth.
- System-prompt rule 5: "If a tool returns no data... say so plainly" (explicit instruction against the missing-data-as-false-answer pattern).
- `groundingGuard.ts`: a quantitative-claim grounding heuristic wired into both sync and streaming RAG turns. It recognizes care-relevant frequencies, percentages, temperatures, durations, lengths, volumes, masses, doses, dilution/repetition forms, fertilizer ratios, and word-quantity dose instructions ("half strength", "double the dose"). Recognized evidence is matched by number and, for safety-sensitive doses, canonical units and denominators expressed with `per` or `/`; unsupported claims are replaced before persistence or display. Streaming RAG output is buffered until the same check passes.
- The guard reports `verified` / `unverified` / `ungrounded`, never a bare boolean pass, and each verdict has its own content-free log event (`chat_grounding_checked` / `chat_grounding_unverified` / `chat_grounding_blocked`) carrying `claimsChecked`, `unclassifiedNumericCount`, and `sourceCount`. An answer the guard recognized nothing in is `unverified` — delivered, but never counted as evidence that anything in it was checked. See [ADR 0009](../adr/0009-three-state-grounding-verdict.md) and [ADR 0008](../adr/0008-unit-aware-rag-grounding.md).

- Pet safety (ADR 0011): the `check_pet_toxicity` tool exposes the curated, ASPCA-grounded `PET_TOXICITY` table through the unchanged public matcher, returning an honest `not_in_checker` on a miss; the guard treats a categorical safety claim ("safe for cats", "non-toxic", Spanish forms) as a claim that only a matching `non-toxic` verdict from that tool can ground, and an unsupported one blocks — replaced by a refusal-with-pointer — even when no other retrieved context exists. Streamed pet-safety turns are held until the guard passes. The danger direction ("toxic") is not gated: a false alarm is the cheaper failure. Residual: a safety claim volunteered on a turn whose question mentions no pet streams before the persisted answer is replaced, and the client keeps streamed text (frontend follow-up).

**Residual, deliberately open:** an `unverified` answer carrying numeric content that fits no checkable claim shape is delivered without blocking. It is counted (`unclassifiedNumericCount`), and whether it should block is a decision waiting on that count — see ADR 0009's consequences.

**Gap:** no live faithfulness/hallucination-rate measurement against real model output exists (`evals/README.md` limitation). **Tracked, dated waiver:** `docs/RESPONSIBLE-TECH-AUDITS.md`.

### Data privacy

**Risk:** PII (household plant/task data, indirectly member names via task assignment) reaching Bedrock, or leaking across households.

**Mitigations:** every structured tool result crosses a centralized recursive model-boundary sanitizer (`chat/tools.ts`) that strips emails, phone fields, Cognito/user/household identifiers, creator/actor fields, and reminder-assignee identity fields in both the live loop and history replay; nested-field regression coverage means a future executor cannot bypass the sanitizer by forgetting a hand-built projection. Raw reminder proposal data stays in the authenticated DDB/UI representation so confirmation still works, but is sanitized before model replay. Tool failures return generic text and do not log the exception message. Household-scoped tool execution prevents cross-household reads because every tool applies the authenticated `householdId`, never model input; conversation rows retain the 30-day DDB TTL; no third-party data sharing occurs beyond the named AWS Bedrock sub-processor.

**Residual limitation:** a field-name guard cannot recognize PII hidden inside a misleadingly generic string value. New tools still require privacy review, while the centralized sanitizer and unit test close the documented "executor forgot to redact a known PII field" failure mode.

### Over-reliance / human-AI configuration

**Risk:** a user treats a chat answer or leaf-health assessment as authoritative advice rather than an aid.

**Mitigations:** leaf-health's `disclaimer` field is schema-required on every response ("cosmetic visual check... not a plant-health diagnosis"). Chat's confirm-before-write architecture means the assistant literally cannot act on its own conclusions. The persistent composer footer says "AI-generated — verify before acting" and remains visible throughout every chat; the authenticated responsive Playwright flow asserts its presence and viewport visibility.

**Closed 2026-07-13:** the audit had incorrectly recorded the disclosure as absent even though the persistent footer and Playwright assertion were already present. This review reconciled the documentation with the tested UI.

### Information security (prompt injection / tool misuse)

**Risk:** a user (or, via RAG, a future untrusted corpus source) tries to get the model to ignore its instructions, call a tool with attacker-chosen input, or exceed the confirm-before-write boundary.

**Mitigations:** fixed, server-defined tool catalog (the model can't invent new tools); `check_pet_toxicity` reads no household data and its verdicts are byte-identical to the table whatever text arrives as `plantName` (red-team `verdict-integrity` invariant); hallucinated-plant-ID rejection (server re-validates by name, never trusts the model's raw ID); per-turn tool-call cap (5); the RAG corpus is first-party authored content (not user- or web-sourced), so classic "indirect injection via untrusted retrieved content" has a much smaller attack surface than a general web-RAG system.

**Residual gap:** the committed red-team exercise covers the offline tool/data
layer with mapped prompt-injection fixtures, but no live-model
refusal/no-fabrication run, Promptfoo OWASP-LLM scan, or Garak baseline exists.
The remaining generation-layer work is tracked by the dated waiver in
`docs/RESPONSIBLE-TECH-AUDITS.md`.

### Value-chain / component integration

**Risk:** dependency on AWS Bedrock's availability, pricing, and model deprecation schedule; a Bedrock-side model deprecation could silently change `BEDROCK_CHAT_MODEL_ID`'s behavior.

**Mitigations:** cost ceiling documented (`quality-audit.md` "Cost ceiling"); budget gate bounds worst-case spend; env-var model selection makes a swap a one-line change.

**Gap:** no monitoring alert on Bedrock model-deprecation announcements. Low priority given the small blast radius (single feature, budget-capped).

---

## Cross-reference

- Non-goals: `docs/chat-rag-design.md` "Non-goals (for V1)".
- Open risks (original design-time list): `docs/chat-rag-design.md` "Open risks".
- Mechanical misuse tests: `backend/tests/unit/services/chatTurn.test.ts`, `chat.test.ts`, `backend/tests/integration/local-server.test.ts:1526`.
- EU AI Act classification: [`eu-ai-act-classification.md`](eu-ai-act-classification.md).
- Model card: [`../../model-card.md`](../../model-card.md).
