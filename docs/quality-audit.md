# Quality audit — Family Greenhouse

> Last verified: 2026-07-05 · Recheck: quarterly, or per RTF-08 audit-as-artifact cadence

A frank, theme-organized assessment of where the system sits across the standard quality attributes ("-ilities"). Grouped by concern because most of the ~150 attributes in the audit checklist (accessibility, accountability, accuracy, … vulnerability) overlap heavily — `flexibility` ≈ `adaptability` ≈ `modifiability`; `reliability` ≈ `dependability` ≈ `fault-tolerance` ≈ `recoverability`. Auditing each as a standalone bullet would produce noise without insight.

Findings are graded:

- **Strong** — confidently meeting the bar for a beta-stage product.
- **Adequate** — works, with known weaknesses we accept for now.
- **Gap** — needs work; risk if not addressed.
- **Deferred** — explicitly out of scope; documented elsewhere.

Every finding cites the file/file-region that backs it.

---

## Architecture & design

### Modularity, composability, orthogonality

**Strong.** Backend has a clean handler / service / model split (`backend/src/{handlers,services,models}`). Each handler owns one HTTP route via the `createHandler` middy stack (`backend/src/middleware/handler.ts`); services are pure DDB/external-API adapters; models hold types and zod schemas. Cross-cutting concerns (auth, validation, body-size, rate limit, audit, error) are middy middlewares, applied uniformly. Frontend mirrors the split: `services/` is API access only, `features/<area>/*` owns the UI for that vertical, `components/` is shared primitives.

### Layering rules and orthogonality

**Strong.** The Perenual integration is the clearest current example: `services/perenual.ts` (raw HTTP) ← `services/enrichment.ts` (cache + budget) ← handlers. Code outside the integration only ever imports `enrichment.ts`. Documented in `docs/perenual.md`.

### Coupling & extensibility

**Strong.** Adding a new endpoint is well-trodden (handler → service → schema → local-server mirror → integration test). The previously-flagged `deleteMe` branches were refactored into named guard helpers (`refuseIfOnlyAdmin`, `wipeSoloHouseholdPlants`); flow now reads top-down.

### Standards compliance

**Strong.** REST conventions consistent. OpenAPI spec at `docs/api-spec.yaml` now documents every one of the 66 handler routes, and `scripts/check-api-spec.mjs` fails CI on any drift (a handler route without a spec entry, or a stale spec entry without a handler). Adding `GET /me/export` in this pass exercised the loop: handler comment → spec entry → green check.

---

## Reliability, fault-tolerance, resilience, recoverability, dependability

### Failure transparency

**Strong (read paths).** Every external integration returns `null`/typed `disabled` rather than throwing — `services/perenual.ts`, `services/plantIdentification.ts`, `services/billing.ts`. Activity recording is fire-and-forget with `.catch(() => {})` so a logging failure can't break a user action.

### Failure transparency (write paths)

**Adequate.** Atomic transact-writes where they matter most: household creation (`createHousehold`), photo timeline (`appendPlantPhoto`). Other multi-step flows (profile rename across N household memberships, account deletion) parallelize updates and accept eventual consistency on partial failure. The risk window is narrow but real; documented in `docs/profile.md` and `docs/deferred-resilience.md`.

### Recoverability after partial failure

**Deferred.** No automatic compensation/rollback for partial multi-row updates. Blast radius is small (≤25 memberships per user, ≤200 plants per household); retries from the user converge quickly. Outbox/saga path documented in `docs/deferred-resilience.md` with concrete trigger conditions for re-opening.

### Fault tolerance under upstream failure

**Strong for read-side enrichment.** Perenual and Plant.id can be down for hours and core flows keep working — verified by the `disabled` sentinel paths and the unit tests in `tests/unit/services/perenual.test.ts`.
**Adequate for the database.** DDB is the single backing store; a regional outage cascades to the entire app. We rely on AWS's regional availability rather than implementing a multi-region replica. Trigger conditions for reopening this and the corresponding sketch are in `docs/deferred-resilience.md`.

### Survivability and disaster recovery

**Gap.** No documented restore drill. DDB has point-in-time recovery configurable in `infrastructure/`; whether it's actually enabled in production should be verified. **Action item:** add a "restore the prod table to staging" exercise to the production checklist.

### Redundancy

**Adequate.** Lambda + DDB + Cognito are inherently multi-AZ inside a region. We are not multi-region; that's appropriate for our cost ceiling and customer geography.

---

## Security, integrity, confidentiality, vulnerability

### AuthN / AuthZ

**Strong.** Cognito for primary auth; middy `authMiddleware()` attaches verified claims to every protected handler. Household scoping is enforced at the service layer (`HOUSEHOLD#<id>` in PK) and request-time via `X-Household-Id`.

### Rate limiting & abuse resistance

**Strong.** `authRateLimit()` on auth endpoints; `userRateLimit()` (`middleware/rateLimit.ts`) on write endpoints (plant create, task create/complete/snooze) — 60 writes/minute per user per route, well above legitimate use. Body-size guard at the edge (`middleware/bodySize.ts`). API Gateway throttling provides outer envelope. Per-container in-memory state with a documented swap-to-DDB path if/when global limits matter.

### Validation

**Strong.** Every mutating endpoint has a zod schema enforced in middleware (`middleware/validation.ts`). Body-size guard at the edge (`middleware/bodySize.ts`) keeps Lambda memory bounded. Tag arrays, phone numbers, time-strings have explicit format validators.

### Data integrity

**Strong at write time.** Transact-writes on household creation; conditional `attribute_exists(PK)` on every update so we never blind-create rows that should already exist. **Gap.** No checksum/hash verification on user-uploaded images; only MIME and size are validated.

### Secrets management

**Strong.** Secrets read via `requireEnv`/`optionalEnv` only; never committed. CI uses GitHub Secrets; production uses SSM Parameter Store wired into Lambda env per `infrastructure/`. Public-API keys are hashed before storage (`services/apiKeys.ts`).

### Audit logging & accountability

**Adequate.** `utils/auditLog.ts` with a small, typed event taxonomy emits structured logs for sensitive events (logins, password resets, profile updates, billing changes, rate-limit trips, account deletion). **Gap.** Logs go to CloudWatch with default retention; no separate immutable audit sink. Acceptable until we have a compliance regime that requires more.

### Privacy & compliance

**Strong.** GDPR-style self-delete (`DELETE /me`) with the only-admin guardrail, and data portability via `GET /me/export` (profile, prefs, memberships, plants, tasks as a downloadable JSON document) — access + erasure both covered. Past completion records intentionally retain user names as historical artifacts (documented). PII flowing to Perenual is limited to species names — a public botanical fact, not user data — documented in `docs/perenual.md`. Privacy policy and terms ship in-repo (`features/legal/{PrivacyPage,TermsPage}.tsx`). **Minor gap.** No DPA template yet; no cookie banner (we use no third-party tracking cookies, so none is required today).

### Vulnerability surface (OWASP)

**Strong.** Past audit pass; SQL-injection N/A (DDB), XSS controlled by React's default escaping + DOMPurify-equivalent React behavior in `dangerouslyInnerHTML`-free codebase, command injection N/A (no shell-out), SSRF N/A (no user-controlled URL fetches outside known providers). Body-size + rate limit address resource exhaustion. **Watch:** image proxy (`/species/:id/thumbnail`) is a 302 to an external URL — we don't fetch + re-serve, so SSRF risk is null today. If we ever switch to fetch-and-stream, re-audit.

---

## Performance, efficiency, scalability, elasticity

### Response time

**Adequate.** Single-table DDB queries are O(items returned). Critical reads (plants list, tasks list) cap at `MAX_QUERY_LIMIT = 200`. No N+1 bugs found; service methods batch where possible. Frontend uses TanStack Query with sensible `staleTime` (Perenual queries: 5–60 minutes).

### Throughput

**Strong.** Lambda + DDB scale per-request; no shared mutable infrastructure. Profile-rename fan-out is parallel via `Promise.all` (`services/householdService.ts:302`), bounded at the 25-membership cap.

### Resource efficiency

**Strong.** No background workers, no idle servers. Cold start cost paid only on infrequent Lambdas. Bundle size enforced via `size-limit` + the `bundle-size` CI job. Perenual budget breaker prevents runaway external calls.

### Elasticity

**Inherited.** Serverless = elastic by definition. We do not stand up extra capacity for events; we trust AWS regional capacity.

### Caching

**Strong.** TanStack Query in the frontend; DDB-backed caches for Perenual data with explicit TTLs (5min for search, 90 days for species detail). `cacheableResponse` helper (`utils/response.ts`) applied to public/static endpoints (`/billing/plans`, `/tasks/templates`, `/species/search`, `/species/:id`) so CloudFront absorbs repeat traffic without burning Lambda invocations. Mutation endpoints stay no-store by default.

---

## Maintainability, modifiability, evolvability, extensibility

### Test coverage

**Strong.** 230 backend tests + 104 frontend tests + Playwright e2e specs (`tests/e2e/`) running both the Vite dev server and the Express mirror in CI. Integration tests against the Express mirror (`tests/integration/local-server.test.ts`) cover the same surface as production. Unit coverage on services is high; UI tests focus on regression-prone components (PlantDetailPage, SpeciesCombobox, ProtectedRoute).

### Code clarity

**Strong.** Comments explain _why_, not what (per project convention). Inline rationale dense in services touching tricky invariants (`activity.ts`, `pestAlerts.ts`, `householdService.ts`).

### Type safety

**Strong.** Strict TypeScript everywhere, both packages. Zod schemas pull double duty as request validation and as the source of inferred types. No `any` lurking outside test fixtures.

### Local development parity

**Strong.** `local-server.ts` mirrors every production handler. Adding a new endpoint without mirroring it is caught by tests. **Adequate (drift risk).** Local server is hand-written, not auto-generated from the handlers — divergence is possible. Worth considering a derivation strategy if it bites us.

### Refactor cost

**Adequate.** Clear seams; renaming a service field requires touching the handler, the local server, the frontend service, and the integration test. That's annoying but it's the price of strict cross-cutting validation.

---

## Observability, debuggability, traceability, transparency

### Structured logging

**Strong.** Pino logger (`utils/logger.ts`) with consistent shape. Audit events go through a typed taxonomy (`utils/auditLog.ts`).

### Distributed traces

**Adequate.** X-Ray active tracing is on at the Lambda level (`infrastructure/modules/api/main.tf:172`); IAM permits trace writes (`lambda_xray` policy attachment). Lambda's auto-instrumentation captures a segment per invocation including AWS SDK v3 subsegments. Application logs include the X-Ray trace id (`utils/logger.ts:currentTraceId`) so a CloudWatch line pivots cleanly into the X-Ray service map. Not covered: cross-Lambda async traces (cron → notifier) — would need explicit `Trace-Id` propagation.

### Operational dashboards

**Adequate.** `infrastructure/modules/monitoring/main.tf` defines a six-panel dashboard: API request rate, 4XX/5XX split, Lambda p95, DDB throttles, Lambda errors, and Perenual daily-budget exhaustion (CloudWatch Logs Insights query). DDB-throttle alarm publishes to the same SNS topic as the Lambda-error alarms. Not deployed yet — that's a Terraform apply away, not a code task.

### Sentry / error tracking

**Adequate.** Code respects `SENTRY_DSN` if set; the actual Sentry project is not yet provisioned (also tracked in `production-checklist.md`).

---

## Usability, accessibility, intuitiveness, learnability

### WCAG 2.2 AA conformance

**Strong.** Documented in `docs/accessibility.md`. ARIA attributes, focus rings, keyboard nav for all interactive elements verified. Form errors associated via `aria-describedby`. Live regions for async error feedback.

### Onboarding

**Adequate.** 3-step `WelcomeFlow` after first household creation; `welcomeSeen` is persisted. No in-product tour beyond that — appropriate for the surface area.

### Responsiveness

**Strong.** Tailwind responsive utility classes used throughout. Mobile-first layout in dashboard, plants grid, settings.

### Localization (i18n)

**Adequate.** `react-i18next` plumbed; English + structure for Spanish + Portuguese in place. `RTL_LANGS` infrastructure ready. **Gap.** No translator engaged; non-English strings are placeholders. Care guides remain English-only (see `docs/perenual.md` for the AWS Translate seam).

### Discoverability

**Adequate.** Global Cmd-K palette (added in this session) finds plants and tasks. Activity feed filters surface what's been happening. No onboarding tooltips on the search affordance — most desktop users will discover Cmd-K through habit.

---

## Operability, deployability, configurability

### Deployments

**Adequate.** Two GitHub Actions workflows (`cd-staging.yml`, `cd-production.yml`) + Terraform in `infrastructure/`. Deployment requires a manual approval on production. **Gap.** No per-PR preview environments — listed as deferred in `roadmap.md` because it's a deploy-infra change, not a coding task.

### Configuration

**Strong.** All secrets/feature toggles live in env vars; `requireEnv`/`optionalEnv` give clean boundaries. Defaults are friendly (e.g. `PERENUAL_DAILY_BUDGET = 80` works without explicit configuration).

### Feature flags

**Adequate.** No formal flag service. Features that need gating (Perenual integration) gate on the presence of an env var, which is sufficient for our cadence. Adding LaunchDarkly-style runtime flags is post-roadmap.

### Boot up / install

**Strong.** `npm install && npm run dev` brings up frontend + local server. No manual DB seeding required (local server self-seeds).

### Backups

**Inherited.** DDB point-in-time recovery is a config switch in `infrastructure/`. Verify it's on in prod before audit close-out.

---

## Cost & sustainability

### Cost ceiling

**Strong.** Every external dependency has a documented "what does this cost at 1,000 households?" answer (Perenual: $10/mo unlimited; Cognito: free up to 50k MAU; SES: ~$0.10 per 1K emails). Lambda + DDB scale linearly with use; no idle cost.

### Footprint

**Strong.** No always-on compute, no big binaries. Frontend bundle constrained by `size-limit`.

### Provider lock-in

**Adequate.** Heavy AWS lock (Cognito, DDB, Lambda, S3, SES, SNS). Migrating off would be substantial. Acceptable trade for the operational simplicity of the stack.

### Third-party dependencies

**Adequate.** Stripe, Perenual, Plant.id, Twilio (SMS) all have abstracted adapter modules. Swapping any one is a single-file change.

---

## Documentation

**Strong.** `docs/` covers architecture, deployment, accessibility, billing, security, testing, notifications, roadmap, production checklist, and now Perenual + profile editing. Inline doc comments are dense and explain rationale. `api-spec.yaml` is complete (all 66 handler routes) and CI-enforced against drift via `scripts/check-api-spec.mjs`.

---

## Cross-cutting risk register

After the audit-driven sweep, the standing risks are:

1. **Disaster-recovery rehearsal not done.** PITR may or may not be on; we've never restored. _Action: verify Terraform, run a staging restore drill, document in `production-checklist.md`. Tracked in `docs/deferred-resilience.md` §5._
2. **E2E flakiness risk.** Playwright e2e is wired in CI (`tests/e2e/{auth,happy-path,create-plant,a11y}.spec.ts`); the gap is now coverage of less-exercised flows. _Action: extend specs as new write paths land — CSV export, bulk template apply, profile rename._
3. **Localization content gap.** Locale picker is flag-gated to English until content lands. The coverage guard is now in place: `frontend/src/i18n/coverage.ts` + `tests/unit/i18n/localeCoverage.test.ts` assert every non-English locale defines all keys (no silent fallbacks) and refuse to enable a locale below 95% translated when `VITE_ENABLE_NON_ENGLISH_LOCALES=true`. Spanish currently measures ~98.7% with zero missing keys — content is closer than the picker gate implies; the remaining blocker is native-speaker review, not coverage.

Closed since the original audit pass:

- ✅ API spec drift → `scripts/check-api-spec.mjs` enforced in CI on every PR.
- ✅ Production observability dashboard → six-panel CloudWatch dashboard + DDB-throttle alarm in `infrastructure/modules/monitoring/`.
- ✅ Distributed traces → X-Ray active tracing on, trace id correlated into structured logs.
- ✅ CDN-aware caching → `cacheableResponse` helper applied to public/static endpoints.
- ✅ Per-user rate limiting → `userRateLimit` on write endpoints.
- ✅ Locale gating → English-only by default behind `VITE_ENABLE_NON_ENGLISH_LOCALES`.
- ✅ Branchy `deleteMe` → guard helpers extracted.

Deferred items with documented re-open triggers live in `docs/deferred-resilience.md`.

---

## Attributes from the audit checklist not separately discussed

These map cleanly to the themes above; no separate finding:

| Audit-list term                                                                                                              | Where it's covered                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| accountability, auditability, traceability                                                                                   | Observability §, Audit logging                        |
| adaptability, agility, evolvability, flexibility, modifiability, tailorability, customizability                              | Maintainability §                                     |
| affordability, efficiency, sustainability                                                                                    | Cost & sustainability §                               |
| availability, dependability, durability, reliability, robustness, fault-tolerance, recoverability, resilience, survivability | Reliability §                                         |
| compatibility, interchangeability, interoperability, portability, standards compliance, platform compatibility               | Architecture § (layering rules), Standards compliance |
| confidentiality, integrity, securability, vulnerability, exploitability, ethics                                              | Security §                                            |
| convenience, familiarity, intuitiveness, learnability, usability, ubiquity                                                   | Usability §                                           |
| credibility, demonstrability, fidelity, precision, accuracy                                                                  | Reliability §, Documentation §                        |
| degradability, failure transparency, repairability, serviceability                                                           | Reliability §, Operability §                          |
| discoverability, inspectability, understandability, readability, transparency                                                | Documentation §, Code clarity                         |
| effectiveness, efficiency, performance, response time, throughput                                                            | Performance §                                         |
| elasticity, scalability, capacity                                                                                            | Performance §                                         |
| installability, deployability, configurability, manageability, operability                                                   | Operability §                                         |
| localizability, internationalization                                                                                         | Usability § (Localization)                            |
| modularity, composability, orthogonality                                                                                     | Architecture §                                        |
| reproducibility, repeatability, predictability, stability, determinability                                                   | Architecture § (test parity), Reliability §           |
| safety, environmental protection                                                                                             | Out of scope for software product                     |
| testability, provability, demonstrability                                                                                    | Test coverage                                         |
| timeliness, schedule, training, documentation                                                                                | Roadmap, Documentation §, Onboarding                  |

If a stakeholder asks about a specific attribute by name, this table maps to where the answer lives.
