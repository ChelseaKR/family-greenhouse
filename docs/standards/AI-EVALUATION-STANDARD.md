# AI Evaluation Standard

The AI-specific companion to `RESPONSIBLE-TECH-FRAMEWORK.md`. The framework asks *what could go wrong, how do we test, what do we commit to, how is it enforced*; this document supplies the **minimum metrics, evidence, and CI gates** for AI/RAG/eval systems. Cross-cutting requirements live here once; projects record only implementation-specific tools, values, and findings in `docs/ROADMAP.md` (Metrics table) and `docs/RESPONSIBLE-TECH-AUDITS.md`.

This standard is intentionally capability-based rather than tied to a repository inventory. A project inherits the controls for the AI behavior it implements, including retrieval, generation, ranking, classification, tool use, or model-based evaluation.

**Regulatory frame (verified 2026-07-31):** [NIST AI RMF 1.0](https://www.nist.gov/itl/ai-risk-management-framework) and the [Generative AI Profile (NIST AI 600-1)](https://doi.org/10.6028/NIST.AI.600-1) supply the risk taxonomy; ISO/IEC 42001:2023 supplies management-system patterns such as a risk register and Statement of Applicability, while [ISO/IEC 42005:2025](https://www.iso.org/standard/42005) supplies AI-system impact-assessment guidance. The [EU AI Act implementation timeline](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai) is phased: prohibited-practice rules have applied since 2025-02-02, GPAI-model obligations since 2025-08-02, transparency and most remaining provisions apply from 2026-08-02, Annex III high-risk rules from 2027-12-02, and high-risk rules for systems embedded in regulated products from 2028-08-02. Applicability depends on the project's role, market, and use case; each project must **record** its classification rather than inherit a portfolio-wide assumption (see §6). This standard is an engineering control set, not a legal determination.

---

## 0. Scope — which systems this binds, and the mandatory N/A declaration

**In scope:** any shipped feature or evaluation pipeline that calls a model to retrieve, generate, summarize, rank, recommend, classify, extract, moderate, select tools, or judge other model output. Apply only the relevant sections: for example, §1 retrieval metrics apply to retrieval systems, while §2 applies to any feature that accepts untrusted input or context.

**Out of scope:** projects with no model inference in a user-facing, automated-decision, or evaluation path. Developer-only autocomplete or one-off exploratory analysis is also out of scope when its output is reviewed before it enters the product or a committed decision artifact.

A project is **never silently out of scope.** Every project's `docs/ROADMAP.md` carries one line:

```
AI-Evaluation-Standard: APPLIES  (tiers: RAG, red-team, model-card)
# or
AI-Evaluation-Standard: N/A — no model inference in any user-facing, automated-decision, or evaluation path. Reviewed <YYYY-MM-DD>.
```

A new runtime or evaluation model call flips the declaration to APPLIES and is itself a REVIEW-GATE. The change introducing that call cannot merge without its applicable gates wired or an explicit, dated waiver in the Metrics table. Merely installing an SDK does not change scope until a model-mediated path uses it.

**Provider note:** this standard is provider-neutral. Each project pins and records the provider, model identifier or snapshot, API version, evaluator version, and judge configuration. A change to any of them triggers the model-version gates in §5. Hosted evaluation services may supplement, but not replace, reproducible evidence committed by CI.

---

## 1. Metric suite — the three-layer eval (AUTO-GATE)

RAG evaluation is **three layers: retrieval, generation, calibration.** A project that retrieves-then-generates must gate all three. Use **RAGAS, DeepEval, or an equivalent pinned evaluator** for offline scoring in the project's normal test stack. Some metrics require references or judge models; the eval manifest must state which inputs and evaluator each metric uses. Production tracing tools belong to the online layer under `OBSERVABILITY-STANDARD` and do not replace an offline merge gate.

The benchmark is a committed, version-controlled set of **100–500 labeled queries** (`tests/eval/benchmark/*.jsonl`) with disaggregation labels (language, segment). It is a build artifact, regenerated and re-committed like any audit.

| Metric | Target | Measured by | Gate | Owner |
|--------|--------|-------------|------|-------|
| Faithfulness / groundedness | ≥ 0.80 | RAGAS/DeepEval over benchmark | AUTO-GATE | — |
| Context Recall @ k=20 | ≥ 0.80 | RAGAS Context Recall | AUTO-GATE | — |
| Context Precision | ≥ 0.70 (narrow-domain) | RAGAS Context Precision | AUTO-GATE | — |
| Answer relevancy | ≥ 0.75 | RAGAS Answer Relevancy | AUTO-GATE | — |
| Citation accuracy (claim-level) | ≥ 0.90 atomic-fact precision | FActScore against retrieved context | AUTO-GATE | — |
| Hallucination / confabulation rate | ≤ 5% on held-out benchmark | reference-free detector + FActScore | AUTO-GATE | — |
| Refusal correctness | ≥ 0.95 on should-refuse set; ≤ 2% over-refusal on should-answer set | labeled refusal benchmark | AUTO-GATE | — |
| Truthfulness (model-version change) | no drop > 3 pp from model-card baseline | TruthfulQA (817 q) | AUTO-GATE on model bump | — |
| Per-segment pass rate (disaggregated) | no segment > 5 pp below the macro mean | benchmark grouped by `segment`/`lang` label | AUTO-GATE | — |
| EN/ES pass-rate parity | \|EN − ES\| ≤ 5 pp | bilingual benchmark slice | AUTO-GATE (bilingual projects) | — |

**Trigger:** these gates run on **every PR touching prompts, retrieval, chunking, reranking, prompt assembly, or the pinned model version.** A path filter on `.github/workflows/eval.yml` plus a label is acceptable, but the eval job is a **required status check**—it cannot be `continue-on-error` or `|| true`.

**No ungrounded code path.** The citation guard is a unit test, not just an aggregate eval metric: a generated claim with no supporting retrieved span is a test failure, asserted with injected fixtures. High-impact claims should use deterministic claim-to-source checks where possible; judge-model scores alone are insufficient evidence.

DeepEval in `pytest` is illustrative reference wiring. Validate names and arguments against the version pinned by the project:

```python
# tests/eval/test_rag_gates.py
import json, pathlib, pytest
from deepeval import assert_test
from deepeval.metrics import FaithfulnessMetric, ContextualRecallMetric, ContextualPrecisionMetric
from deepeval.test_case import LLMTestCase

CASES = [json.loads(l) for l in (pathlib.Path(__file__).parent / "benchmark/civic.jsonl").read_text().splitlines()]

@pytest.mark.parametrize("row", CASES, ids=lambda r: r["id"])
def test_rag(row):
    tc = LLMTestCase(
        input=row["query"], actual_output=row["answer"],
        retrieval_context=row["contexts"], expected_output=row["reference"],
    )
    assert_test(tc, [
        FaithfulnessMetric(threshold=0.80),
        ContextualRecallMetric(threshold=0.80),    # k=20 retrieval
        ContextualPrecisionMetric(threshold=0.70),
    ])
```

```makefile
# Makefile — same target CI runs (no local/remote drift)
eval:
	uv run pytest tests/eval -q --eval-report=docs/audits/eval-run.json
verify: lint type test security eval   # eval is part of the blocking chain
```

---

## 2. Red-team / jailbreak suite (AUTO-GATE on critical; REVIEW-GATE for the structured exercise)

Use **Garak or an equivalent scanner** for broad baseline probes and **Promptfoo or an equivalent application-level harness** for policy- and threat-mapped checks. Use **PyRIT or equivalent orchestration** when a structured exercise needs stateful, multi-turn attacks. Tool capabilities change; conformance is determined by the required coverage, recorded findings, and gates below—not by a product name.

The required checklist is the **[OWASP Top 10 for LLM Applications 2025 (v2.0)](https://genai.owasp.org/llm-top-10/)** (LLM01–LLM10). Every LLM feature is reviewed against all ten before ship; the report records the mapping and marks non-applicable categories with a reason.

| Control | Target | Measured by | Gate |
|---------|--------|-------------|------|
| OWASP LLM01–LLM10 red-team scan | 0 critical-severity findings open | Promptfoo `redteam` (OWASP plugin) | AUTO-GATE on prompt/model PR |
| Broad baseline probe suite | 0 critical regressions vs. baseline | Garak or equivalent, scheduled + on model bump | AUTO-GATE |
| Prompt-injection (direct + indirect, RAG context) | resists curated injection corpus | Promptfoo + project injection fixtures | AUTO-GATE |
| System-prompt / context leakage | no system prompt or other-tenant context emitted | Promptfoo `harmful:privacy` + leak probes | AUTO-GATE |
| Structured multi-turn red-team | findings triaged, severities assigned, remediation tracked | PyRIT or equivalent → committed report | REVIEW-GATE, ≥ quarterly + each major model/prompt release |

```yaml
# promptfooconfig.yaml — illustrative current shape; pin the Promptfoo version in CI
purpose: Answer questions only from approved retrieved sources.
targets:
  - id: https://localhost:8000/answer
redteam:
  plugins: [owasp:llm]
  strategies: [jailbreak, prompt-injection, base64]
  numTests: 25
```

CI runs the pinned tool's red-team command, writes machine-readable results, and invokes a repository-owned check that fails on an open critical finding or a critical regression. Tool defaults or dashboard severity alone do not implement the gate.

The structured exercise produces `docs/audits/red-team-<date>.md` (scope, findings, severity, OWASP category, remediation, and sign-off), committed and regenerated per release.

---

## 3. Judge calibration (AUTO-GATE) + the eval-driven-development loop

LLM-as-judge metrics are only trustworthy if the judge tracks human labels. Review 50–100 sampled traces, score the same traces with the automated judge, and make agreement and Cohen's kappa merge-blocking gates.

| Metric | Target | Measured by | Gate |
|--------|--------|-------------|------|
| Judge ↔ human raw agreement | ≥ 0.80 | calibration set (50–100 labeled traces) | AUTO-GATE |
| Cohen's kappa | ≥ 0.60 | same | AUTO-GATE |
| Calibration freshness | set re-labeled within 30 days | timestamp on `tests/eval/calibration/*.jsonl` | AUTO-GATE (stale set fails) |
| Judge drift (month-over-month) | tracked, no silent degradation | kappa trend committed to eval report | REVIEW-GATE |

The full eval-driven-development loop (REVIEW-GATE for the online + drift layers, since they need judgment and committed artifacts):

1. **Offline** — the §1 benchmark gates every prompt/model change in CI. (AUTO)
2. **Online** — use a documented, privacy-reviewed sampling plan sized to the system's traffic and risk; score sampled traces and log the results. Keep judge work off the user-response path unless the feature explicitly requires synchronous moderation. (REVIEW — wire via `OBSERVABILITY-STANDARD` traces; this is N/A-with-reason for systems with no production traffic.)
3. **Calibration** — the weekly human pass above; document kappa, track drift monthly. (AUTO for the gate, REVIEW for the drift narrative.)

---

## 4. Model cards & data cards as committed artifacts (AUTO-GATE on completeness; REVIEW-GATE on honesty)

Transparency artifacts are **committed files regenerated on release**—consistent with `RESPONSIBLE-TECH-FRAMEWORK.md` §D. Use a Hugging Face-compatible **model card** when its metadata fits the system and **Datasheets for Datasets** (Gebru et al., 7 sections) for datasets. A project that consumes rather than trains a model still needs a system/model card documenting the pinned model, intended and out-of-scope use, evaluation results, data handling, and limitations; fields that apply only to trained or published models are N/A-with-reason.

| Artifact | Required content | Measured by | Gate |
|----------|------------------|-------------|------|
| `docs/cards/model-card.md` | Stable model/provider identifier and version; intended and **out-of-scope use**; eval results with relevant per-group breakdown; data handling; limitations; CO₂/compute if trained; applicable publication metadata | schema/section lint appropriate to the card type | AUTO-GATE |
| `docs/cards/data-card-*.md` | All 7 datasheet sections: Motivation, Composition, Collection, Preprocessing, Uses, Distribution, Maintenance — non-empty | section-presence lint (pre-run hook before any fine-tune) | AUTO-GATE |
| Environmental footprint | GPU-hours + CO₂e (CodeCarbon / ML CO₂ Impact) | committed to model card, training projects only | AUTO-GATE on train; **N/A-with-reason** for API-only projects |
| Card honesty / framing | limitations and out-of-scope are truthful, not box-ticking | accountable-owner review | REVIEW-GATE per release |

```yaml
# .github/workflows/cards.yml — project-owned schema/section lint
- run: uv run python scripts/check_ai_cards.py
```

Datasheet completeness is a **pre-run hook**: a fine-tune or training run with a missing/empty-section datasheet **aborts**.

---

## 5. Regression gates — how the thresholds bind in CI

The gate is **regression on a committed baseline**, not an absolute floor alone. Each project commits `docs/audits/eval-baseline.json`; the CI eval job fails if any §1 metric drops below its threshold **or** regresses > the per-metric tolerance from baseline.

| Change class | Gates triggered |
|--------------|-----------------|
| Prompt template / system prompt | §1 full suite, §2 Promptfoo OWASP, §3 calibration freshness |
| Retrieval / chunking / reranker | §1 retrieval metrics (recall@20, precision), faithfulness, citation accuracy |
| Pinned model version bump | §1 full suite, §2 Garak + Promptfoo, TruthfulQA drift ≤ 3 pp, model-card update required |
| New benchmark queries | re-baseline (REVIEW-GATE: owner approves the new baseline JSON) |
| New AI feature / first model call | all of the above + §6 risk classification (REVIEW-GATE) |

**Reference, don't repeat:** the eval thresholds above are stated once here. A project's `docs/ROADMAP.md` Metrics table records only its *measured* values and any justified deviation (e.g. a broad-domain system raising the Context Precision target's domain qualifier), each carrying a one-line rationale. Silent deviation is a defect.

---

## 6. Governance artifacts — NIST AI RMF / ISO 42001 and 42005 / EU AI Act (REVIEW-GATE)

These require human judgment, so they are REVIEW-GATEs paired with a committed artifact and an accountable-owner sign-off. They extend `RESPONSIBLE-TECH-AUDITS.md`, not duplicate it.

| Artifact | Frame | Trigger / cadence | Gate |
|----------|-------|-------------------|------|
| `docs/audits/ai-risk-register.md` | NIST AI RMF **MAP**: inventory each AI system, its risk tier, which of the 12 AI 600-1 GenAI risks apply (confabulation, bias/homogenization, data privacy, info integrity, etc.) | before any new AI feature ships; review ≥ quarterly | REVIEW-GATE |
| `docs/audits/ai-impact-assessment-<feature>.md` | ISO/IEC 42005 impact assessment: impacts on individuals, groups, and society across the lifecycle | per feature that processes personal data, makes consequential decisions, or faces external users | REVIEW-GATE |
| `docs/audits/iso42001-soa.md` | ISO/IEC 42001 Statement of Applicability: applicable Annex A controls + exclusion rationale | per production AI system; review annually + on architecture change | REVIEW-GATE |
| EU AI Act classification line | Annex III high-risk? GPAI? compute near 10²⁵ FLOPs? | per AI feature; recorded in the risk register | REVIEW-GATE — **must be explicit** |

**Classification is mandatory and explicit.** A typical entry: *"Not Annex III high-risk (no recruitment, credit, law-enforcement, education, migration, or critical-infrastructure decisioning); project is a deployer, not a GPAI-model provider; API-only, training compute = 0. Reviewed <YYYY-MM-DD> by <owner>."* Record relevant jurisdictions and organizational role; using a GPAI model does not by itself make the project a GPAI-model provider. If a feature is classified as high-risk, applicable conformity-assessment and documentation obligations become a hard pre-ship REVIEW-GATE on the effective timeline recorded in the risk register.

Project-specific **no-inference, no-outing, no-profiling, and protected-trait** guarantees are first-class risk-register entries. Enforce them with deterministic tests at the data and tool boundaries; do not rely only on prompts or judge-model scores.

---

## What gets committed into each AI project

Per `DOCUMENTATION-STANDARD.md`, each in-scope project carries, regenerated by `make verify` / on release:

- `tests/eval/benchmark/*.jsonl` — the 100–500-query labeled, disaggregated benchmark.
- `tests/eval/calibration/*.jsonl` — the dated judge-calibration set.
- `docs/audits/eval-run.json` + `eval-baseline.json` — the eval artifact and its baseline.
- `docs/audits/red-team-<date>.md` — the structured red-team report.
- `docs/cards/model-card.md` + `docs/cards/data-card-*.md`.
- `docs/audits/ai-risk-register.md`, `iso42001-soa.md`, `ai-impact-assessment-*.md`.
- One ROADMAP line declaring APPLIES (with tiers) or N/A-with-reason.

Every item is either an AUTO-GATE (mechanically checked, merge-blocking) or a REVIEW-GATE (human sign-off + committed artifact). There is no third "aspirational" category.

---

Last verified: 2026-07-31 · Recheck cadence: at least quarterly; at each applicable EU AI Act phase gate; when NIST AI RMF / AI 600-1, ISO/IEC 42001 or 42005, or the OWASP Top 10 for LLM Applications changes; and whenever a pinned evaluator or scanner ships a breaking metric, schema, or threshold change. CI must use pinned tool versions and validate configuration against those versions.
