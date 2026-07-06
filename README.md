# Family Greenhouse

[![CI](https://github.com/ChelseaKR/family-greenhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/ChelseaKR/family-greenhouse/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-familygreenhouse.net-639922)](https://familygreenhouse.net)
[![License: Elastic-2.0](https://img.shields.io/badge/license-Elastic--2.0-2f6f4e)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-installable-639922)](https://familygreenhouse.net)
![React](https://img.shields.io/badge/React-19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![AWS](https://img.shields.io/badge/AWS-Lambda%20%2B%20DynamoDB%20%2B%20Cognito-ff9900)

**A shared plant-care journal for the whole household** — a collaborative houseplant tracker with per-plant watering schedules, recurring care tasks (water, fertilize, prune…), and reminders that find the right person across browser, email, and SMS, so nobody has to ask "did you water the Monstera?" ever again.

🌿 **Live demo:** **[familygreenhouse.net](https://familygreenhouse.net)** &nbsp;·&nbsp; 📚 **Docs:** [`docs/`](docs/) &nbsp;·&nbsp; 🧭 **Start here:** [`docs/development.md`](docs/development.md)

Built with React + TypeScript on the frontend and AWS Lambda + DynamoDB (single-table) + Cognito on the backend, plus a local Express dev server that mirrors the API surface so you can develop entirely offline — no AWS account or third-party keys required to run it locally.

> _In loving memory of my mom, Joyce - who taught us to keep growing. 🌱_

## What's in here

```
family-greenhouse/
├── frontend/         React + Vite SPA
├── backend/          Lambda handlers + a local Express mock that mirrors them
├── infrastructure/   Terraform stack (network, Cognito, DDB, S3, API Gateway, CloudFront)
├── docs/             Detailed docs — start with development.md if you're new
├── scripts/          One-off shell helpers
├── .github/          CI + CD workflows
└── package.json      npm workspaces root
```

## Quickstart for developers

You need Node 22+ (see `.nvmrc`) and npm 10+. From the repo root:

```bash
npm install                       # installs across all workspaces

# Two terminals:
npm --workspace backend run dev   # local Express mock at :4000
npm --workspace frontend run dev  # Vite dev server at :3000
```

Open http://localhost:3000 and sign in with `test@example.com` / `password123` — the dev server seeds a household for you on boot.

For everything else (running tests, deploying, configuring channels) follow the deeper docs:

- [`docs/development.md`](docs/development.md) — local dev workflow, where to add a new endpoint
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit, single-table DDB layout, request lifecycle
- [`docs/deployment.md`](docs/deployment.md) — from-zero AWS deploy
- [`docs/testing.md`](docs/testing.md) — the test pyramid we run + how to add to it
- [`docs/notifications.md`](docs/notifications.md) — browser, email, SMS, web-push details
- [`docs/billing.md`](docs/billing.md) — Stripe integration, plan caps, webhook flow
- [`docs/public-api.md`](docs/public-api.md) — read-only public API: key auth, scopes, rate limits, endpoints
- [`docs/production-checklist.md`](docs/production-checklist.md) — gating list for going live
- [`docs/incidents.md`](docs/incidents.md) — severity levels, the first 15 minutes, post-mortem template
- [`docs/runbooks.md`](docs/runbooks.md) — step-by-step fixes (rollback, DDB throttle, Stripe webhooks, PITR…)
- [`docs/support.md`](docs/support.md) — user-issue triage + common resolutions

## What works today

Headline features that are wired end-to-end:

- **Households**: invite-link based, role-aware (admin/member), enforced via Cognito custom claims
- **Plants**: CRUD, photo upload (with S3 presigned URL race-fixed), species autocomplete from a curated catalog, plant-name shuffle, optional Plant.id-powered identification from a photo
- **Tasks**: types (water/fertilize/prune/repot/custom), recurring frequency, complete/snooze/edit, assigned-to lookups
- **Care history**: per-plant + household activity feed
- **Notifications**: browser pop-ups, web push (VAPID), email (SES), SMS (SNS) — each one configurable per user under Settings → Notifications
- **Subscriptions**: Stripe-backed Seedling/Garden/Greenhouse tiers; plan caps enforced server-side; in-app upgrade flow with Stripe Checkout + customer portal

What needs real infra credentials to leave demo mode is enumerated in [`docs/production-checklist.md`](docs/production-checklist.md). Every channel/integration falls back gracefully to a structured log line when its env var isn't set, so you don't need a single key to develop locally.

## Day-to-day commands

```bash
npm test                                      # everything (workspaces)
npm --workspace backend run test:watch        # vitest watch on backend
npm --workspace frontend run test:e2e         # Playwright (boots both servers)
npm run typecheck                             # strict TS across both workspaces
npm run lint                                  # eslint across both workspaces
npm run format                                # prettier
```

## Contributing

Branches off `main`, conventional-commits style messages, PR with passing CI:

```
feat(plants): add identification from photo
fix(billing): clamp price-id env lookup
docs: rewrite README
```

Types we use: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`. The commitlint hook in `.husky/` will reject anything else.

## Standards conformance

This repo is onboarded to the portfolio's `STANDARDS/` (vendored at `docs/standards/`, pinned `v1.0.1`). State is honest, not aspirational — most rows are **gap tracked**, not **met**; a green-everything table with no backing evidence is worse than an accurate amber one. Full detail (per-control findings, ASVS level, AI-eval waiver, RTF §A–F) lives in [`docs/RESPONSIBLE-TECH-AUDITS.md`](docs/RESPONSIBLE-TECH-AUDITS.md); this table is the required top-level declaration (DOC-11/12/13).

| Standard                                                                          | Applies?                                                                        | State                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [QUALITY-AND-METRICS](docs/standards/QUALITY-AND-METRICS-STANDARD.md)             | Applies                                                                         | Gap tracked — DoD checklist, DORA snapshot, AI-capabilities checklist missing                                                                                                                                                               |
| [CODE-QUALITY](docs/standards/CODE-QUALITY-STANDARD.md)                           | Applies (TS/Node; Python N/A)                                                   | Gap tracked — coverage floors below the 80×4 target (ratchet plan needed), beyond-strict TS/ESLint flags not yet on, CODEOWNERS/branch-ruleset evidence added this pass                                                                     |
| [SECURITY-AND-SUPPLY-CHAIN](docs/standards/SECURITY-AND-SUPPLY-CHAIN-STANDARD.md) | Applies — **ASVS L2** (real PII: emails, phones, photos, household graphs)      | Gap tracked — no CodeQL, no SBOM/signing, no Scorecard; gitleaks pre-commit + version bump added this pass                                                                                                                                  |
| [CI-CD](docs/standards/CI-CD-STANDARD.md)                                         | Applies                                                                         | Gap tracked — no zizmor, no branch-ruleset artifact, no `make verify` parity (added this pass); skip-lighthouse bypass closed and staging e2e silencing removed this pass                                                                   |
| [OBSERVABILITY](docs/standards/OBSERVABILITY-STANDARD.md)                         | Applies — backend ≈ Tier A-adapted (serverless), frontend ≈ Tier B (Web Vitals) | Gap tracked — no SLO yaml, no RUM (Sentry plumbed but DSN-less); see `## Observability` below                                                                                                                                               |
| [ACCESSIBILITY](docs/standards/ACCESSIBILITY-STANDARD.md)                         | Applies                                                                         | Gap tracked — no committed SR/keyboard walkthrough artifact, no ACR/VPAT yet; AAA-overstatement in docs corrected this pass (axe gate enforces AA only)                                                                                     |
| [INTERNATIONALIZATION](docs/standards/INTERNATIONALIZATION-STANDARD.md)           | Applies (opted in — EN/ES)                                                      | Gap tracked — `no-literal-string` enforced on one file only, no pseudolocale test, no `docs/I18N.md`                                                                                                                                        |
| [AI-EVALUATION](docs/standards/AI-EVALUATION-STANDARD.md)                         | **Applies** — production Bedrock chat (tool-use + RAG) + leaf-health vision     | **Dated waiver** (expires 2026-10-05) — starter benchmark + citation/grounding guard + model card committed this pass; full RAGAS-class metric suite, red-team scan, judge calibration not yet built. See `docs/RESPONSIBLE-TECH-AUDITS.md` |
| [DOCUMENTATION](docs/standards/DOCUMENTATION-STANDARD.md)                         | Applies                                                                         | Gap tracked — this table + CHANGELOG.md + `Last verified` stamps + CITATION.cff added this pass                                                                                                                                             |
| [RELEASE-AND-VERSIONING](docs/standards/RELEASE-AND-VERSIONING-STANDARD.md)       | Applies — tagged releases drive prod deploys                                    | Gap tracked — `package.json` versions were frozen at `0.1.0` vs. tags at `v0.13.1`; realigned to `0.13.1` this pass. No SBOM/signed-tag verification in CD yet (tag signing configured locally; CD enforcement is a follow-up)              |
| [RESPONSIBLE-TECH-FRAMEWORK](docs/standards/RESPONSIBLE-TECH-FRAMEWORK.md)        | Applies (PII + AI)                                                              | Gap tracked — `docs/RESPONSIBLE-TECH-AUDITS.md` (§A–F) added this pass; DPIA, ISO 42001 SoA, and a published a11y ACR/VPAT are not yet committed                                                                                            |

**On "gap tracked":** every gap above is detailed with a specific missing artifact/gate in `docs/RESPONSIBLE-TECH-AUDITS.md` and the dated audit trail in `docs/quality-audit.md`. Per-gap GitHub issues (so DOC-13's "gaps link open issues" is literal, not just narrative) are a manual follow-up — filing them is a repo-owner action, not something this pass executed (see the conformance-remediation execution log for the exact commands).

## Observability

**Backend:** CloudWatch + X-Ray (active tracing on every Lambda invocation), structured JSON logs via `pino` with `requestId`/`userId`/`householdId`/`traceId` correlation (`utils/logger.ts`). Tier: **A-adapted for serverless** — the OBSERVABILITY-STANDARD's `/livez`/`/readyz` probes are N/A (no long-lived process to probe; deploy smoke-tests hit `/billing/plans` instead, see `cd-production.yml`). Six-panel CloudWatch dashboard + alarms defined in `infrastructure/modules/monitoring/` (request rate, 4XX/5XX, Lambda p95, DDB throttles, errors, budget exhaustion).

**Frontend:** Tier **B** — lab-only Web Vitals via Lighthouse CI (LCP <2500, CLS <0.1, a11y ≥0.95, gated on every PR touching `frontend/**`). **RUM: not yet** — Sentry is wired end-to-end in code (`SENTRY_DSN`/`VITE_SENTRY_DSN`) but is a no-op until a DSN is provisioned (`docs/compliance.md` §5).

**Gaps (tracked):** no SLO yaml, no burn-rate alerting, no per-route RED contract, no OTel/W3C `traceparent` (X-Ray-native instead). See `docs/RESPONSIBLE-TECH-AUDITS.md` and the remediation plan for the fuller list.

**Supported:** latest tagged release only (pre-1.0) — see [`CHANGELOG.md`](CHANGELOG.md).

## License

[Elastic License 2.0](LICENSE) — the source is free to read, run, modify, and
self-host for your own household. What it doesn't allow is offering Family
Greenhouse (or a substantial copy of it) to others as a hosted/managed
service. If that's something you want to do, get in touch:
support@familygreenhouse.net.
