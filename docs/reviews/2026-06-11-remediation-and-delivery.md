# Remediation & Roadmap Delivery — 2026-06-11

Companion to [2026-06-11-deep-review.md](2026-06-11-deep-review.md). Every finding in that review
(security, bugs, performance, test gaps, mock drift) has been remediated, and the full feature
roadmap (Horizons 1–4) has been implemented — **except the beta/monetization flip, which remains
deliberately OFF** (`VITE_BETA_MODE` untouched; identification metering ships env-gated off).

Scope of change: ~198 files (129 modified, 69 new), +13.5k/−2.2k lines.
Verification at completion: backend **843 tests** green (70 files, unit + integration incl. a new
route-parity contract guard), frontend **260 tests** green (39 files), `tsc --noEmit` clean in both
workspaces, eslint clean (`--max-warnings 0`), `terraform validate` clean, esbuild emits all 15 bundles.
**Nothing was committed, deployed, or applied** — the working tree is ready for review/commit, and
infra changes take effect only on `terraform apply` + the next CD release.

---

## 1. Security remediation (all closed)

| Finding                               | Fix                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 Cognito self-escalation (CRITICAL) | `custom:household_id`/`custom:household_role` removed from app-client `write_attributes` (auth/main.tf); defense-in-depth: `authMiddleware` now validates the claim household against the membership table on EVERY request (role comes from the member row, never the claim) |
| S2 Climate IDOR                       | Both climate routes 403 cross-household; tests added                                                                                                                                                                                                                          |
| S4 Removed members keep access ≤1h    | Same membership-validation change closes it (≤60s cache-staleness residual, honestly documented)                                                                                                                                                                              |
| S3 Rate limiter broken/bypassable     | Rewritten for payload-format 2.0 (`requestContext.http.sourceIp`, `rawPath`), XFF never trusted, bucket eviction added, first-ever tests                                                                                                                                      |
| S5 Unmetered paid endpoints           | Rate limits on identify (10/min), species routes, run-reminders (2/h), image presign (20/min); 5s timeout on Plant.id fetch; presign content-type allowlist + 5 MiB HeadObject check at confirm                                                                               |
| updateProfile confused-deputy         | GetUser sub-compare, 403 on mismatch, authRateLimit added                                                                                                                                                                                                                     |
| CI/CD AdministratorAccess             | Replaced with a scoped customer-managed policy (service-bounded). ⚠️ Watch the first CD run; the report comment includes the rollback command                                                                                                                                 |
| SES IAM `*`                           | Scoped to the verified identity ARN (SNS `Publish` must stay `*` — AWS constraint, documented)                                                                                                                                                                                |

## 2. Bug remediation (all closed)

P0: reminder spam (one-per-user-per-day TTL dedupe), chat tool_result persistence (+ pair-aware
trimming, SK uniqueness), task-reassignment GSI2 sync (+ assignedToName re-resolution), Stripe
webhook apply-before-ledger + out-of-order guard (`lastStripeEventCreated`), claim corruption on
member removal/role change, deleteMe full multi-household + prefs/push/API-key GDPR cleanup.

P1/P2: idempotent completeTask (no ghost-row resurrection), lifecycle filtering everywhere (lists,
ICS), refresh-token queue, multi-tab logout cascade, CSV formula injection, stale streaks, overdue
re-announce, DST day-math, household-scoped query keys (`['plants', hh, …]`), pagination
(plants/analytics), snooze-from-now, timezone validation + DND fail-open, pest "may"-month fix +
pestAlerts actually wired into reminders, unassigned-task reminders, atomic plan-cap counters
(plantCount/memberCount on METADATA, TransactWrite, legacy backfill), perenual secret retry, push
endpoint SHA-256 keys, JSON error contract `{message, details?}` end-to-end, plus all "low" items
(audit taxonomy, schema bounds, Object.hasOwn, router-404 CORS, lazy logging identity, ICS
single-occurrence VEVENTs, best-effort activity, awaited/conditioned lastUsedAt).

## 3. Performance & cost (all applied)

CloudFront `/plants/*` behavior + `ASSETS_BASE_URL` URL minting (photos now servable + edge-cached);
public thumbnail route + inline `thumbnailUrl`; Cognito call off the plant-write path (denormalized
member name); `Promise.all`/transact on write paths; alarm consolidation 26→~6 (≈−$2/mo); S3
noncurrent-version lifecycle; lazy Stripe + Sentry imports; AWS SDK v3 bundled (externals removed);
reminders restructured to one GSI1 query per household (scan kept, directory-GSI documented as the
scale fix); client-side image downscale (≤1600px WebP) before upload.

## 4. Structural: mock parity + tests

`local-server.ts` rewritten to mirror production contracts (auth semantics, JSON errors, real Zod
schemas, join flow, confirm flow, all missing routes, 127.0.0.1 bind, prod-env guard). New
`route-parity.test.ts` asserts every production route exists in the mock — drift now fails CI.
Coverage added for every previously-untested area: public API layer, apiKey middleware,
membershipCache, auditLog, plans, taskTemplates, weather, enrichment, chat corpus/bedrock,
rate limiter, error handler, species thumbnail allowlist.

## 5. Roadmap delivered (Horizons 1–4)

**H1 (retention):** weekly plants-at-risk digest (pref-gated, weekly dedupe, EventBridge Mon 13:00 UTC),
end-of-year recap email (Jan 2, once-per-year markers), CSV/JSON bulk import (≤100/req, partial
success at cap, drag-drop preview UI at `/plants/import`), one-tap climate skip ("rain expected —
skip this cycle" chips on water tasks).

**H2 (collaboration + AI):** chat `propose_reminder_task` tool — model proposes, user confirms via
in-chat card, creation only via the normal authed endpoint; streaming end-to-end groundwork
(Bedrock response streaming + SSE Function-URL handler with **in-handler `aws-jwt-verify`** since
Function URLs bypass the API GW authorizer + Terraform function/URL/outputs + CD wiring — OFF until
the `PRODUCTION_CHAT_STREAM_URL` repo var is set); task claiming (atomic claim/unclaim, "up for
grabs" badges); vacation mode (read-time coverage mapping, auto-reverts, reminder redirection);
SMS phone verification (hashed 6-digit codes, attempt caps; unverified numbers never receive SMS).

**H3 (monetization depth — built, not switched on):** Plant.id metering (3/30/100 per month by tier,
tracked always, **enforced only when `IDENTIFY_METERING_ENABLED=1`** — beta unaffected); public API
`write:tasks` scope + `POST /api/v1/tasks/{id}/complete|snooze` (never granted implicitly to legacy
keys; machine actor `apikey:{id}`); `docs/oauth-design.md` (auth-code + PKCE, GA gates);
downgrade-overage banner + usage meters via `GET /billing/me` usage block; propagation tracker
(`parentPlantId` lineage, propagate-cutting flow, lineage card); cutting share (snapshot
`SHARE#{code}` rows, public preview page `/shared/{code}`, plan-capped accept).

**H4 (big bets, scoped deliberately):** leaf-health check (`POST /plants/{id}/health-check`,
Bedrock vision, strict-JSON assessment, demo-mode fallback, downscaled upload dialog on the plant
page); `docs/b2b-greenhouse-mode.md` (pilot-gated design, explicitly no code until a nursery pilot).

## 6. Deploy notes (in order)

1. Review + commit the working tree; CI runs the full suite.
2. `terraform apply` — expect a large plan: Cognito client write_attributes (the critical fix),
   alarm replacement, CICD policy swap, digests Lambda + 2 schedules, chat-stream function + URL,
   ~17 new routes, lifecycle rule, CloudFront behavior change.
3. **Watch the first CD run** after the CICD policy swap (rollback command in cicd/main.tf comment).
4. Optional toggles, all default-off: `PRODUCTION_CHAT_STREAM_URL` repo var (streaming),
   `IDENTIFY_METERING_ENABLED=1` (metering), and the beta flip itself — still off by design.
5. Existing users' tokens minted before the Cognito change keep old claims until refresh; the new
   middleware membership check makes that safe immediately.
