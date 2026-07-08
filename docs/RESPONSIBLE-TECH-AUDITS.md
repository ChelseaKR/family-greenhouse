# Responsible-Tech Audits — family-greenhouse

Instantiates `STANDARDS/RESPONSIBLE-TECH-FRAMEWORK.md`. Last regenerated: 2026-07-05 (baseline — first time this file exists; created as part of the 2026-07-05 conformance-audit remediation).

This is the detail layer behind the README's `## Standards conformance` table. Where a control needs a number or a mechanical gate, it's owned by the sibling standard and only referenced here (per the framework's "reference, don't repeat" rule).

---

## Applicability

- **A Ethics:** applies
- **B Bias:** applies (light) — plant-care content and care-guide copy; EN/ES is the one first-class segment (no ranking/classification of people; the app never infers protected attributes)
- **C Privacy:** applies — real PII (emails, phone numbers, plant/household photos, household membership graphs). DPIA-style content exists today in `docs/compliance.md` §3 (GDPR checklist) but is **not yet** a signed, dated `docs/audits/dpia.md` — tracked gap, see P2-1 in the remediation plan
- **D Transparency:** applies — model card: [`model-card.md`](../model-card.md)
- **E Accessibility:** applies — see [`accessibility.md`](accessibility.md) (WCAG 2.2 AA enforced; ACR/VPAT not yet published — tracked gap, P2-3/P2-4)
- **F Security:** applies — ASVS **L2** (declared below); threat model: [`security.md`](security.md) (OWASP Top 10 working audit) + [`security-review-2026-05-31.md`](security-review-2026-05-31.md)
- **AI-EVAL:** **APPLIES** (tiers: tool-use + RAG, citation/grounding guard, model-card; red-team and full RAGAS-class metric suite **not yet built** — see the dated waiver below). This repo predates its addition to `STANDARDS/AI-EVALUATION-STANDARD.md`'s explicit repo list; per that standard's §0, "a new `uses:` of an LLM SDK flips the declaration to APPLIES" regardless of whether the repo was enumerated when the standard was written.
- **I18N:** applies (opted in) — EN/ES catalogs, i18next. See `docs/I18N.md` gap tracked in P2-9.

---

## A. Ethics & responsibility audit

**Findings:** Family Greenhouse is a consumer household-collaboration tool with an LLM-backed care assistant. Worst plausible misuse: a household member using the chat to get pesticide/dosing advice beyond what's safe, or the assistant inventing a watering schedule that harms a plant (low-stakes) or a user's trust. Worst plausible failure: the assistant fabricates a household member's data across households (mitigated structurally — see BOLA tests) or silently invents plant-identification data (previously an actual bug class, fixed in #170/#171 — "missing perenual data" was surfaced as a false negative, not a fabricated positive; see the model card's known-failure-modes section).

- **Non-goals statement:** `docs/chat-rag-design.md` "Non-goals (for V1)" — no photo-based identification via chat, no multi-tenant/marketing chat, no agentic destructive actions without confirmation, text-only. Carried forward into the model card.
- **Misuse-resistance (mechanical, AUTO-GATE):** hallucinated-plant-ID rejection (`chat/index.ts` — server-side proposal validation ignores the model's raw plantId and re-looks-up by name), per-turn tool-call cap (5), per-household token budget with atomic reservation (#136), write-nothing-without-confirm architecture (`propose_reminder_task` never calls `POST /tasks` itself). Unit-tested in `backend/tests/unit/services/chatTurn.test.ts` / `chat.test.ts`.
- **Kill-switch:** `BEDROCK_CHAT_MODEL_ID` env var + the Garden-plan-and-up gate in `chat/index.ts` are both single points that already exist to disable/gate the feature; no dedicated feature-flag kill-switch beyond that today (gap — cheap to add, not yet built).
- **Accountable owner:** Chelsea Kelly-Reif (solo maintainer).
- **Gate:** REVIEW-GATE — this section is the sign-off; re-review on any prompt or tool-catalog change.

## B. Bias & fairness audit

**Findings:** No ranking/classification of people; the assistant answers about plants, not people. The one live segment is EN/ES — chat itself is English-only today (see AI-EVAL declaration above; `INTERNATIONALIZATION-STANDARD.md` I18N-20-26 MF2/AI-bilingual rows are N/A because the chat doesn't localize). Representational-harm surface is narrow: plant-care advice content, not user-generated or user-classifying content.

- **Commitment:** never infer a user's protected attributes; the assistant only ever reasons over plant/task/climate data it retrieves via tools.
- **Gate:** REVIEW-GATE, light-touch given the narrow surface — re-review if/when chat gains multi-language responses.

## C. Privacy & data-protection audit (DPIA-style)

**Findings:** Real PII in play: emails, phone numbers, plant/household photos, household membership graphs, and (new with chat) conversation transcripts that may reference a household's plants/tasks (30-day TTL, `docs/chat-rag-design.md` "Privacy"). `docs/compliance.md` §3 covers lawful basis, subject rights (self-serve export/delete), sub-processors (AWS, Stripe, Perenual/Plant.id/OpenWeather, and now Bedrock) — but as a checklist, not a signed DPIA artifact.

- **Commitment:** retention limits (30-day chat TTL; DDB item TTL generally), self-serve access/deletion (`GET /me/export`, `DELETE /me`), no third-party exfiltration beyond named sub-processors, tool-result redaction before anything reaches Bedrock (`chat/tools.ts` strips emails/Cognito subs/createdBy).
- **Gate:** AUTO-GATE — no-PII-in-logs / redaction is unit-tested (`chat/tools.ts` redactor). REVIEW-GATE — a signed `docs/audits/dpia.md` is **not yet committed**; tracked gap (remediation P2-1, depends on this file).

## D. Transparency & explainability audit

**Findings:** Every chat answer is attributable to either a tool call (the user's own data — inherently sourced) or the RAG corpus (`search_care_knowledge` → `backend/src/data/plant-care-corpus/`). Model card: [`model-card.md`](../model-card.md).

- **Commitment:** model card exists with intended/out-of-scope use, known failure modes, and eval-baseline reference. "AI-generated, verify before acting" framing is a documented open risk in `chat-rag-design.md` ("Open risks") but is **not yet rendered in the chat UI** — tracked gap (add a footer disclosure string + a Playwright assertion that it's present; cheap follow-up, not done in this pass).
- **Gate:** AUTO-GATE — citation/grounding guard is unit-tested, see `evals/README.md` and `backend/src/services/chat/groundingGuard.ts`; it validates the guard logic against synthetic fixtures and checks RAG-corpus retrieval recall against the starter benchmark. It is **not yet wired as a hard block into the live `turnEvents` response path** — see the AI-EVAL waiver below for the honest scope of what's enforced today vs. tracked.

## E. Accessibility audit

Owned by `ACCESSIBILITY-STANDARD.md`; narrative in `docs/accessibility.md`. No chat-specific a11y gap beyond the existing app-wide gates (the chat panel is a normal React surface, covered by the same axe/Lighthouse suites).

## F. Security audit

**Threat model:** `docs/security.md` (OWASP Top 10 working audit, re-run each release) + `docs/security-review-2026-05-31.md`. Chat-specific: BOLA/cross-household isolation tests (`backend/tests/integration/local-server.test.ts:1526`), tool-guard tests, budget-exhaustion tests.

**§F declarations (SECURITY-AND-SUPPLY-CHAIN-STANDARD.md §8 — no blanks):**

1. **ASVS level: L2.** Rationale: the app holds real PII (emails, phone numbers, photos, household graphs) and has both an authentication and authorization surface with external network ingress. L2 is satisfied by the AUTO-GATE set (parameterized DDB access via DocumentClient, Zod validation, TLS-only) plus the §5-class authz integration tests already present: function-level authz (`local-server.test.ts:695`) and object-level/BOLA (`local-server.test.ts:1526`).
2. **Container scanning:** N/A (no Dockerfile — Lambda zip + static-site deploy, no container image is ever built).
3. **SBOM + signing:** **gap.** Not configured on any release artifact (frontend dist / Lambda zips). Tracked in the remediation plan P2-7 (CycloneDX SBOM + GitHub artifact attestations).
4. **Secret-management policy:** GitHub Actions repository secrets for CI/CD-time values (`AWS_DEPLOY_ROLE_ARN`, `AWS_PRODUCTION_ROLE_ARN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`); OIDC (no long-lived AWS keys). Runtime secrets are plain Lambda env vars today; AWS Secrets Manager migration is planned but not yet done (`docs/security.md` A02 "Open" item, `production-checklist.md`). Rotation: manual, on suspected exposure; no scheduled rotation policy committed yet (gap).
5. **VEX:** none claimed. No unfixable HIGH/CRITICAL dependency CVE is currently being waived — the one deliberate exclusion (`npm audit --omit=dev`) is a scoping choice with inline rationale in `ci.yml`, not a VEX-class waiver of a specific fixed-but-accepted vulnerability.

---

## AI-EVALUATION-STANDARD — dated waiver + current state

**Declaration (mirrors the required `docs/roadmap.md` Metrics-ledger line):**

```
AI-Evaluation-Standard: APPLIES (tiers: tool-use + RAG, citation/grounding guard, model-card)
```

**Headline finding (from the 2026-07-05 audit):** a production LLM/RAG feature — Bedrock-hosted chat (model configurable via `BEDROCK_CHAT_MODEL_ID`; current code default and the unconfigured production value is Claude **Haiku 4.5** `us.anthropic.claude-haiku-4-5-20251001-v1:0`, not the Sonnet 4.6 the original design doc (`chat-rag-design.md`) called for — see the model card for the full discrepancy note) plus Titan Embeddings v2 RAG — shipped through 13+ releases with **zero** AI-evaluation gates: no benchmark, no baseline, no citation guard, no red-team scan, no model card. Per `AI-EVALUATION-STANDARD.md` §0, this state "could never have merged" once declared.

### Dated waiver

> **Waived as of 2026-07-05, owner Chelsea Kelly-Reif (CKR). Expires 2026-10-05 (≤ 1 quarter).**
>
> The following AI-EVALUATION-STANDARD gates are **not yet fully wired** and are explicitly waived, not silently skipped, until the expiry date above:
>
> - **§1 full RAGAS/DeepEval three-layer metric suite** (faithfulness ≥0.80, context recall/precision, answer relevancy, citation accuracy, hallucination rate, refusal correctness, per-segment breakdown, TruthfulQA drift). This standard's reference tooling is Python (`uv run pytest`); this is a Node/TypeScript monorepo. **What exists instead (this pass):** a starter benchmark (`evals/benchmark.jsonl`, 24 questions across all 11 corpus articles — the standard's target is 100–500) and a citation/grounding guard (`backend/src/services/chat/groundingGuard.ts` + unit tests) that checks retrieval recall against expected source documents and flags ungrounded numeric care claims in synthetic fixtures. This is a real, CI-gated starter, **not** the full RAGAS metric suite — no faithfulness/hallucination/refusal scoring against live model output exists yet, because that requires calling live Bedrock, which is out of scope for an offline CI gate without a dedicated eval-run budget and is not something this remediation pass executes against real AWS infrastructure.
> - **§2 red-team / Promptfoo OWASP-LLM scan + Garak baseline.** Not built. What exists: mechanical misuse-resistance tests (hallucinated-ID rejection, budget caps, tool-call caps — see audit A above) which cover some OWASP LLM categories (LLM01 prompt injection partially, via the fixed tool catalog; LLM06 excessive agency, via the confirm-before-write architecture) but were not run as a structured, mapped red-team exercise.
> - **§3 judge calibration.** N/A — no LLM-as-judge is in use (no automated grading of chat output by a second model).
> - **§6 governance:** `docs/audits/ai-risk-register.md` and `docs/audits/eu-ai-act-classification.md` **are** committed as of this pass (see below). `docs/audits/iso42001-soa.md` and a feature-level `docs/audits/ai-impact-assessment-chat.md` are **not** — tracked as follow-on gaps, same expiry.
>
> **Freeze during the waiver window:** no bump of `BEDROCK_CHAT_MODEL_ID`, no system-prompt rewrite, and no new tool added to `TOOL_REGISTRY` should merge without re-running the starter eval (`npm run eval`) and updating `evals/eval-baseline.json` — the CI job added in this pass (`ci.yml` `ai-eval` job) already enforces this mechanically for the benchmark/citation-guard layer.
> **What "done" looks like when the waiver expires:** either (a) a real RAGAS/DeepEval-class harness scoring live Bedrock output against the expanded 100+-query benchmark, or (b) a written, dated decision that the Node-native starter harness in `evals/` is the permanent, portfolio-accepted equivalent for non-Python repos, with the specific numeric floors this repo commits to instead of RAGAS's defaults. Whichever it is, it must be a decision, not a silent lapse — if 2026-10-05 arrives with neither, the correct action is to re-issue this waiver dated and explain why, not let it expire silently.

### What's measured today (baseline)

See `evals/eval-baseline.json` and `evals/README.md` for the full method and honest limitations (in particular: retrieval is validated against each benchmark question's own source chunk embedding as a proxy, not a live Titan-embedded query — see that README for why, and what a real end-to-end eval would additionally need).

---

## Governance (AI repo)

| Artifact                                   | Status                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/audits/ai-risk-register.md`          | ✅ committed this pass                                                                                                                                                                                           |
| `docs/audits/eu-ai-act-classification.md`  | ✅ committed this pass                                                                                                                                                                                           |
| `docs/audits/iso42001-soa.md`              | gap — not committed; low priority given "minimal risk" classification below, but should exist before any Annex-III-adjacent feature (e.g. automated plant-health diagnosis marketed as medical/diagnostic) ships |
| `docs/audits/ai-impact-assessment-chat.md` | gap — not committed; `docs/compliance.md` §3 covers similar ground informally                                                                                                                                    |
| `docs/audits/red-team-<date>.md`           | gap — no structured red-team exercise has been run                                                                                                                                                               |

---

Last verified: 2026-07-05 · Recheck cadence: quarterly, and immediately on any Bedrock model swap, system-prompt rewrite, or new tool added to the chat tool registry.
