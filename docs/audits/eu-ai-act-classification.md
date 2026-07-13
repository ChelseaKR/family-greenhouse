# EU AI Act classification — family-greenhouse

Per `STANDARDS/RESPONSIBLE-TECH-FRAMEWORK.md` "Governance scaffolding for AI systems": classification is mandatory and must be explicit, even when the answer is "not high-risk." Silence is a defect; this is the write-down.

## Classification

**Not Annex III high-risk. Not a GPAI model (this repo consumes a hosted model via API, doesn't build one).**

Rationale:

- **No Annex III category applies.** Annex III's high-risk categories are: biometric identification/categorization, critical infrastructure management, education/vocational-training access or scoring, employment/worker-management decisions, access to essential public/private services (credit scoring, insurance, emergency services), law enforcement, migration/asylum/border control, and administration of justice/democratic processes. Family Greenhouse is a consumer plant-care assistant — none of these apply. The closest tangential category is "essential private services," which the Act's guidance interprets as things like credit/insurance access, not a household chore-tracking app.
- **Not a general-purpose AI (GPAI) model.** This repo doesn't train or fine-tune a model; it calls a hosted third-party model (Claude on Bedrock) via API for a narrow, single-purpose task. GPAI obligations attach to the model provider (Anthropic/AWS), not to a downstream API consumer using it for a specific application — this repo is squarely in the "AI system built on top of a GPAI model" category, which the Act treats as a normal (non-GPAI) deployer obligation.
- **Training compute:** zero. No training or fine-tuning run occurs in this repo.
- **Limited-risk transparency obligations (Art. 50) — do apply:** the chat is explicitly presented as the plant-care assistant, and a persistent, plain-language footer beside the composer says "AI-generated — verify before acting" throughout the interaction. The authenticated responsive Playwright flow asserts that the disclosure is present and visible. This reconciles the original 2026-07-05 audit, which incorrectly recorded the existing footer as absent.

## What would change this classification

- Adding a feature that makes or materially influences a consequential decision about a person (credit, employment, insurance, legal eligibility) would require re-classifying that specific feature, not the whole app.
- Marketing or repositioning the leaf-health check as **diagnostic** (rather than cosmetic) plant-health or, worse, extending it toward anything read as medical/veterinary diagnosis would raise materially different risk questions (though still unlikely to hit an Annex III category, since Annex III doesn't cover plant/animal health) — regardless, the product's own non-goals (`chat-rag-design.md`, `leafHealth.ts` system prompt) explicitly hold this line today.
- If Family Greenhouse ever fine-tunes or self-hosts a model (departs from "API-only"), the GPAI/training-compute rows above need re-review.

## Review

- **Classified by:** Chelsea Kelly-Reif.
- **Date:** 2026-07-13 (first classification 2026-07-05; transparency control re-verified 2026-07-13).
- **Recheck cadence:** per feature that adds new AI-driven decisioning, and at minimum on every major EU AI Act phase-gate (next: Annex III conformity deadline 2027-12-02, not applicable here unless the classification above changes).
