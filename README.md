# Family Greenhouse

[![CI](https://github.com/ChelseaKR/family-greenhouse/actions/workflows/ci.yml/badge.svg)](https://github.com/ChelseaKR/family-greenhouse/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-familygreenhouse.net-639922)](https://familygreenhouse.net)
[![License: Elastic-2.0](https://img.shields.io/badge/license-Elastic--2.0-2f6f4e)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-installable-639922)](https://familygreenhouse.net)
![React](https://img.shields.io/badge/React-19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![AWS](https://img.shields.io/badge/AWS-Lambda%20%2B%20DynamoDB%20%2B%20Cognito-ff9900)

**A shared plant-care journal for the whole household** — a collaborative houseplant tracker with per-plant watering schedules, recurring care tasks (water, fertilize, prune…), and reminders that find the right person across browser, email, and SMS, so nobody has to ask "did you water the Monstera?" ever again.

🌿 **Technical demo (no purchases):** **[familygreenhouse.net](https://familygreenhouse.net)** &nbsp;·&nbsp; 📚 **Docs:** [`docs/`](docs/) &nbsp;·&nbsp; 🧭 **Start here:** [`docs/development.md`](docs/development.md)

> **Commercial activity hold — July 14, 2026.** Family Greenhouse remains a
> portfolio and technical-demonstration project. It is not currently accepting
> new account registrations or payments, offering paid plans, conducting launch
> or customer outreach, or generating revenue. Existing account holders can
> still sign in. Pricing, billing, launch, and marketing material is kept only
> as historical product-design documentation. See
> [`docs/COMMERCIAL-STATUS.md`](docs/COMMERCIAL-STATUS.md).

Built with React + TypeScript on the frontend and AWS Lambda + DynamoDB (single-table) + Cognito on the backend, plus a local Express dev server that mirrors the API surface so you can develop entirely offline — no AWS account or third-party keys required to run it locally.

> _In loving memory of my mom, Joyce - who taught us to keep growing. 🌱_

## What's in here

```
family-greenhouse/
├── frontend/         React + Vite SPA (+ Capacitor iOS/Android shells — docs/mobile.md)
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
- **Plan architecture**: Seedling/Garden/Greenhouse caps are enforced server-side; the historical Stripe implementation remains in source, but payment creation is fail-closed during the commercial hold

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

This repo is onboarded to the portfolio's `STANDARDS/` (vendored at `docs/standards/`, pinned `v1.0.1`). State is honest, not aspirational: completed controls name their evidence and residual gaps stay explicit. Full detail (per-control findings, ASVS level, AI-eval waiver, RTF §A–F) lives in [`docs/RESPONSIBLE-TECH-AUDITS.md`](docs/RESPONSIBLE-TECH-AUDITS.md); this table is the required top-level declaration (DOC-11/12/13).

| Standard                                                                          | Applies?                                                                        | State                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [QUALITY-AND-METRICS](docs/standards/QUALITY-AND-METRICS-STANDARD.md)             | Applies                                                                         | Partial — exact merge gates and the DoD are committed in `DEFINITION_OF_DONE.md`; automated portfolio DORA reporting and the seven-part AI-capabilities governance record remain gaps                                                                                         |
| [CODE-QUALITY](docs/standards/CODE-QUALITY-STANDARD.md)                           | Applies (TS/Node; Python N/A)                                                   | Partial — strict TypeScript, zero-warning ESLint, coverage floors, CODEOWNERS, and branch rules are gated. Backend clears 80% on all four coverage metrics; frontend floors are ratcheted below the portfolio's 80% target                                                    |
| [SECURITY-AND-SUPPLY-CHAIN](docs/standards/SECURITY-AND-SUPPLY-CHAIN-STANDARD.md) | Applies — **ASVS L2** (real PII: emails, phones, photos, household graphs)      | Partial — CodeQL, Semgrep, Gitleaks, npm audit, Scorecard, SHA-pinned Actions, and a complete dependency disposition are gated/evidenced; release SBOM, provenance, and signed-tag enforcement remain gaps                                                                    |
| [CI-CD](docs/standards/CI-CD-STANDARD.md)                                         | Applies                                                                         | Met for current service shape — committed no-bypass ruleset + CODEOWNERS, strict required checks, OIDC deploys, workflow audit, concurrency, and `make verify` parity; production deployment retains its explicit Environment approval                                        |
| [OBSERVABILITY](docs/standards/OBSERVABILITY-STANDARD.md)                         | Applies — backend ≈ Tier A-adapted (serverless), frontend ≈ Tier B (Web Vitals) | Met for current service shape — 28-day SLO contract, health-excluded RED metrics, burn-rate alerts, X-Ray, first-party browser RUM, release correlation, and regression gate; see `## Observability` below                                                                    |
| [ACCESSIBILITY](docs/standards/ACCESSIBILITY-STANDARD.md)                         | Applies                                                                         | Partial — WCAG 2.2 AA axe coverage spans public and authenticated routes, Lighthouse and keyboard/reflow/reduced-motion gates pass; release-time screen-reader/high-contrast walkthrough and a published ACR/VPAT remain human/external gates                                 |
| [INTERNATIONALIZATION](docs/standards/INTERNATIONALIZATION-STANDARD.md)           | Applies (opted in — EN/ES)                                                      | Partial — `docs/i18n.md`, EN/ES key/placeholder/plural/TODO gates, UTF-8 validation, and a hardcoded-string ratchet exist; native-speaker sign-off, pseudolocale overflow, RTL logical-property lint, and remaining literal migration remain                                  |
| [AI-EVALUATION](docs/standards/AI-EVALUATION-STANDARD.md)                         | **Applies** — production Bedrock chat (tool-use + RAG) + leaf-health vision     | **Dated waiver** (expires 2026-10-05) — starter benchmark + live quantitative grounding block + model card; full RAGAS-class metric suite and red-team scan not yet built. Judge calibration remains N/A while no LLM-as-judge is used. See `docs/RESPONSIBLE-TECH-AUDITS.md` |
| [DOCUMENTATION](docs/standards/DOCUMENTATION-STANDARD.md)                         | Applies                                                                         | Met for current scope — README declaration, DoD, CHANGELOG, citation metadata, ADRs, API contracts, operational runbooks, and dated audit artifacts are committed and drift-gated where mechanical                                                                            |
| [RELEASE-AND-VERSIONING](docs/standards/RELEASE-AND-VERSIONING-STANDARD.md)       | Applies — tagged releases drive prod deploys                                    | Partial — root/workspace versions are aligned at 0.20.0; tag/version and CHANGELOG gates run at the tagged ref. Release SBOM/provenance and blocking signed-tag verification remain open                                                                                      |
| [RESPONSIBLE-TECH-FRAMEWORK](docs/standards/RESPONSIBLE-TECH-FRAMEWORK.md)        | Applies (PII + AI)                                                              | Partial — §A–F audit, dated DPIA, AI risk register, model card, EU classification, disclosure, and live grounding/privacy controls are committed; ISO 42001 SoA and a published ACR/VPAT remain gaps                                                                          |

**On partial rows:** the unresolved work is either protected by the dated AI-evaluation waiver, tied to an external production/account/hardware gate, or named in the corresponding audit with a re-open trigger. Historical remediation notes do not override this current declaration.

## Observability

**Backend:** CloudWatch + X-Ray (active tracing on every Lambda invocation), structured JSON logs via `pino` with `requestId`/`userId`/`householdId`/`traceId` correlation (`utils/logger.ts`). Tier: **A-adapted for serverless** — the OBSERVABILITY-STANDARD's `/livez`/`/readyz` probes are N/A (no long-lived process to probe; Route53 continuously checks `/health`). The dashboard and alarms in `infrastructure/modules/monitoring/` cover native gateway health, per-route RED signals, Lambda/DynamoDB saturation, DLQs, browser errors, Core Web Vitals, and integration budgets. Application SLO metrics exclude synthetic `GET /health` traffic.

**Frontend:** Tier **B** — Lighthouse remains the lab gate (LCP <2500, CLS <0.1, a11y ≥0.95), and a small first-party RUM rail reports sanitized browser errors plus LCP/CLS/INP to CloudWatch with route and release correlation. It honors Do Not Track and sends no stack traces, query strings, user ids, or free text. Optional Sentry plumbing remains available but is not required for baseline coverage.

The 28-day 99.5% availability, p95 latency, saturation, and frontend-experience objectives are machine-checked in [`observability/slos.yaml`](observability/slos.yaml). Operational queries and response steps are in [`docs/observability.md`](docs/observability.md). OTel/W3C `traceparent` remains intentionally deferred while the service uses X-Ray-native correlation.

**Supported:** latest tagged release only (pre-1.0) — see [`CHANGELOG.md`](CHANGELOG.md).

## License

[Elastic License 2.0](LICENSE) — the source is free to read, run, modify, and
self-host for your own household. What it doesn't allow is offering Family
Greenhouse (or a substantial copy of it) to others as a hosted/managed
service. If that's something you want to do, get in touch:
support@familygreenhouse.net.
