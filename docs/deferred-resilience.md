# Deferred resilience gaps

The quality audit (`docs/quality-audit.md`) flagged a handful of items that are real engineering work, not one-session changes. This doc captures the rationale for deferring each, the trigger condition that should re-open the question, and a sketched-out path forward when we do tackle it.

## 1. Outbox / saga pattern for multi-row writes

**Status:** deferred.

**What's missing.** Several flows mutate multiple rows that aren't covered by a single `TransactWrite`:

- `PATCH /auth/me` updates Cognito + every `HouseholdMember.name`
- `DELETE /me` removes plants → tasks → invites → membership → Cognito user
- `joinHousehold` writes a membership row + records an activity event

If any one step after the first fails, the rows drift. Today the user can retry and the system converges; activity events are written fire-and-forget so they can drop without breaking core flows.

**Why deferred.** Our blast radius is small: ≤25 memberships per user, ≤200 plants per household. A retry from a 5xx response converges in seconds. The tooling overhead of an outbox/saga (a queue, a worker, dead-letter handling, idempotency keys) is high relative to the failure rate we observe.

**Trigger to re-open.** Any of:

- A user-reported case where partial-failure drift left their account in an unrecoverable state.
- Membership cap raised past 100 (cross-household admin tools).
- A second integration that needs the same atomic-fan-out shape (e.g. ingesting ICS calendar events, where partial success would silently lose tasks).

**Sketched path.** EventBridge + SQS for the outbox; one queue per fan-out type with a DLQ. Each step writes its intent row first (`PK = OUTBOX#{txId}, SK = STEP#{n}`), the worker drains and confirms. Idempotency via DDB conditional updates keyed on `txId`.

## 2. Multi-region DynamoDB

**Status:** deferred.

**What's missing.** Single-region DDB; an AWS regional outage takes the app down.

**Why deferred.** Multi-region means DDB Global Tables, which roughly doubles DDB cost and forces conflict-resolution thinking we don't need at our scale. AWS regional outages are rare and our customers don't have the SLA expectations of a B2B SaaS — a few hours of unavailability while a region recovers is survivable for a household plant-care app. Adding the complexity without a customer ask is the wrong trade.

**Trigger to re-open.** Any of:

- A B2B contract whose SLA requires <1hr regional failover.
- A second region's customer base becoming material (e.g. 25%+ EU users where round-tripping to us-east-1 hurts UX).
- A multi-region customer (greenhouse-as-a-service deployment serving multiple geographies).

**Sketched path.** Promote the single table to a Global Table with replicas in two regions. Update the SDK config to talk to the local replica via region-pinning. Frontend already supports per-region API endpoints. Failover is DNS-driven via Route 53 health checks.

## 3. Per-tenant DDB read-through cache

**Status:** deferred.

**What's missing.** DDB reads pass through to DDB on every Lambda cold start. No ElastiCache layer.

**Why deferred.** Cold-start frequency is low (Lambdas stay warm under reasonable traffic). DDB's own latency (single-digit ms for our access patterns) is the dominant component of API response time, but it's not the bottleneck — frontend rendering and HTTP round-trip dominate. Adding ElastiCache pays cost (always-on cluster) for marginal latency savings.

**Trigger to re-open.** p95 API latency exceeds 300ms with DDB's own latency accounting for >40% of the request budget.

**Sketched path.** ElastiCache for Redis in front of `getPlants`/`getTasks` reads; cache invalidation on the corresponding write paths. Probably not worth doing without DAX (DDB Accelerator) being seriously evaluated as the simpler alternative first.

## 4. Throughput: profile-rename fan-out

**Status:** **already addressed.** The audit listed this as a gap; on review the implementation already uses `Promise.all` over memberships (`backend/src/services/householdService.ts:302`), so the fan-out is parallel, not sequential. With the membership cap at 25, total wall time is bounded by a single DDB UpdateItem (~10ms p50). The audit doc has been corrected.

## 5. Database resilience beyond regional AZ failover

**Status:** deferred.

**What's missing.** Single backing store; no read-replicas, no async standby, no point-in-time-recovery rehearsal.

**Why deferred.** PITR is a Terraform flag (`point_in_time_recovery { enabled = true }` on the table). The actual gap is that we've never restored from a backup — if PITR isn't enabled, or is enabled but the snapshot is broken, we'd find out the worst possible way.

**Trigger to re-open.** Before launch, full stop. Listed in `production-checklist.md`.

**Sketched path.** Same-day work: verify `point_in_time_recovery.enabled = true` on the prod table, then run a staging restore drill (`aws dynamodb restore-table-to-point-in-time` against a non-prod target table name, validate the restored data, document the runbook). Add the runbook to `production-checklist.md` and the deployment workflow.

**✅ DONE 2026-06-09.** PITR confirmed enabled; restore drill run against the live table → throwaway target, **35/35 items validated, RTO ≈ 3.5 min, RPO ≈ 5 min**, throwaway table deleted. Full procedure (with the validation + cutover steps) is in [`runbooks.md` → Data restore (DynamoDB PITR)](runbooks.md#data-restore-dynamodb-pitr). Re-run ~quarterly.

---

## Items that are _not_ deferred

For clarity, these audit-flagged items were addressed during the same session that produced this doc — no follow-up needed:

- API spec drift → `scripts/check-api-spec.mjs` enforced in CI.
- CDN caching → `cacheableResponse` helper applied to public/static endpoints.
- Per-user rate limiting → `userRateLimit` middleware applied to write endpoints.
- Distributed traces → X-Ray active tracing already on; trace id now correlated into structured logs.
- Production dashboard → `infrastructure/modules/monitoring/main.tf` extended with the four panels and the DDB-throttle alarm.
- Locale gating → non-English locales feature-gated via `VITE_ENABLE_NON_ENGLISH_LOCALES`.
- Refactor branchy paths in `deleteMe` → guard helpers extracted.
