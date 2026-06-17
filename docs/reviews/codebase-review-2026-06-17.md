# Comprehensive codebase review — 2026-06-17

Five parallel deep reviews (backend logic, backend security/API, frontend, infrastructure/CI-CD,
tests/architecture), each reading current `main` and verifying against prior remediations rather
than re-reporting fixed items. Headline: **the codebase is in strong shape** — no critical or
high _security_ vulnerabilities in code, prior hardening genuinely holds, type safety is excellent,
and the hard paths (auth/authz, Stripe idempotency, reminder fan-out, plan-cap counters) are
well-engineered and well-tested. The findings below are real bugs, operational risks, and
maintainability liabilities — not a rehash of the closed OWASP items.

Findings are deduplicated across reviewers (a finding raised by two agents is listed once with both
references) and grouped by severity = real-world impact.

## HIGH — fix soon

**H1. DND users silently lose their daily reminder entirely.** `backend/src/services/reminders.ts:140`
claims the per-user daily dedupe slot _before_ `notifier.sendToUser` (`:164`) runs, but DND
suppresses email + SMS (only browser push survives). The marker is already written, so the hourly
cron skips that user for the rest of the day. A user with a DND window covering the cron hour their
task first comes due, who relies on email/SMS (no push subscription), gets **no reminder that day**.
This silently breaks the core product loop and is invisible because the marker write "succeeds."
_Fix:_ only claim the slot after a channel actually delivered (return a delivered? boolean from
`sendToUser`), or don't claim when every enabled non-push channel is DND-suppressed.

**H2. Overdue-alert "seen" set is not household-scoped.** `frontend/src/hooks/useOverdueAlerts.ts:5`
uses one global `sessionStorage` key (`fg.overdueAlerts.announced`) but is fed whichever household's
tasks are active. On a household switch, household B's overdue tasks all fire as "newly overdue"
(notification spam), and the in-memory `announced` ref persists across the switch inconsistently.
_Fix:_ key the ref and storage key by active household id; reset on change.

**H3. Mobile sidebar never closes on navigation.** `frontend/src/components/Layout.tsx:197-210` —
the mobile drawer's `NavLink`s have no `onClick` to close the headlessui `Dialog`, so tapping a nav
item navigates while the focus-trapped drawer + backdrop stay mounted over the new page. Mobile-only
(desktop sidebar is a separate instance). _Fix:_ pass an `onNavigate` that calls
`setSidebarOpen(false)`.

**H4. Production `terraform apply` is not behind the `production` environment approval gate.**
`.github/workflows/cd-production.yml` — only `deploy-backend` carries `environment: production`
(where the required-reviewer gate lives). The `terraform` job runs `apply -auto-approve` _first_,
with no gate, so any `v*` tag triggers an unreviewed prod infra apply (can replace Cognito/DDB/
CloudFront/IAM). The approval only stops the lambda code push that follows. _Fix:_ add
`environment: production` to the `terraform` and `deploy-frontend` jobs.

**H5. Deploy role can self-escalate to admin.** `infrastructure/modules/cicd/main.tf:163-170` grants
`iam:*` on `role/family-greenhouse-*`, which includes `iam:AttachRolePolicy` on the deploy role's
own ARN — a compromised CI run can attach `AdministratorAccess` to itself. Also `s3:*` on `*` and
`iam::*:role` (any-account ARN). _Fix:_ explicit `Deny` on `iam:*RolePolicy`/`AttachRolePolicy`
against the deploy role's own ARN; pin the account id; scope `s3:*` to project buckets.

**H6. The integration suite tests a 3,334-line parallel reimplementation, not the real handlers.**
`backend/src/local-server.ts` is a hand-maintained Express clone of every route (~120 `(req as any)`
casts, no type coupling to the real middy handlers). `critical-path`/`propagation-share` integration
tests run against it, so the real middleware composition is never exercised end-to-end, and every
route change must be written twice. The route-parity test keeps the route _list_ honest but not the
_behavior_. Largest maintainability liability. _Fix (longer-term):_ drive integration tests through
the real router via a Lambda-event adapter, or at least share the auth/validation logic.

**H7. No check that handler routes match the Terraform `routes` map.** `tests/integration/route-parity.test.ts`
checks handlers↔local-server, and `check-api-spec.mjs` checks handlers↔OpenAPI, but **nothing** checks
handlers↔`infrastructure/modules/api/main.tf` (the 90-entry list API Gateway actually wires). A route
added everywhere except `main.tf` deploys as a 404 with no gate catching it. _Fix:_ parse `route_key`
entries from `main.tf` and assert set-equality with the handler routes.

## MEDIUM

**M1. Paid-API spend has no hard global cap by default.** `backend/src/middleware/rateLimit.ts` is
in-memory per-warm-container, so the ceiling is `N containers × max`. `POST /plants/identify`
(Plant.id, real per-call credit) and the Bedrock leaf-health check can be cost-amplified by
concurrency; the identify monthly meter ships **disabled** (`IDENTIFY_METERING_ENABLED` unset) and
leaf-health has no monthly cap. (Chat is correctly hard-capped by token budget.) _Fix:_ set
`IDENTIFY_METERING_ENABLED=1` in prod, add a Bedrock monthly cap, and/or move the limit to a DDB
conditional counter. — _(backend-security M1)_

**M2. Images S3 bucket has no lifecycle policy.** `infrastructure/modules/frontend/main.tf:85-111` —
deleted-plant photos and abandoned presigned-PUT uploads accumulate forever (cost creep + user
images persist after account deletion = data-retention/GDPR gap). The frontend bucket has lifecycle;
images doesn't. _Fix:_ add `abort_incomplete_multipart_upload` + noncurrent/orphan expiry; tighten
CORS from `*` to the site origin; consider versioning for durability.

**M3. Public-API activity feed can under-return.** `backend/src/services/taskService.ts:564-579`
(`getHouseholdActivity`, behind `GET /api/v1/activity`) runs a `Limit`-bounded GSI1 query then
filters `entityType === 'TaskCompletion'` in memory — but that partition now also holds
`ActivityEvent` rows, so a page that's mostly ActivityEvents returns far fewer than the limit.
_Fix:_ paginate (`queryAllPages`) or return the unified envelope like `listActivity`.

**M4. Task `assignedTo` is never validated as a current household member.** create/update/import
accept any UUID; the name lookup returns null but the task still writes with a bogus assignee →
invisible in every member's "assigned to me" view, rolls into unassigned in reminders. Not a
cross-household leak (partition is always the caller's). _Fix:_ 400 when `getMemberByUserId` is null.
— _(backend-logic M4 + backend-security L1)_

**M5. Completion/year-in-review attribute work to the email prefix, not the member name.**
`backend/src/handlers/tasks/handler.ts:191` — `user.email.split('@')[0]` (with a leftover TODO) is
persisted as `completedByName` and drives the activity feed, `YearInReview.byMember`, and the recap
email. "Jane Smith" shows up as "jsmith". _Fix:_ resolve via `getMemberByUserId` like the plants
handler's `resolveActorName`. — _(backend-logic M2 + tests L3)_

**M6. `useMetaTags` rebuilds head tags on every render.** `frontend/src/hooks/useMetaTags.ts:75`
has the inline `jsonLd` object in its effect dep array; `BlogPost` constructs it fresh each render,
so the JSON-LD script and title flicker out/in every render. _Fix:_ depend on a stringified/memoized
value.

**M7. `ProtectedRoute` and `Layout` subscribe to the whole auth store.** `ProtectedRoute.tsx:6` and
`Layout.tsx:57` call `useAuthStore()` with no selector, so every silent token refresh re-renders the
entire layout subtree. _Fix:_ use selectors / `useShallow`.

**M8. Chat SSE parser throws on a malformed frame.** `frontend/src/services/chatService.ts:154` —
`JSON.parse` per `data:` line with no try/catch; one bad frame aborts the stream (the caller falls
back to a full sync round-trip). _Fix:_ try/catch per line, `continue` on parse failure.

**M9. `docs/multi-household.md` authz section is stale and now wrong on a security path.** It claims
the middleware "downgrades role to member" on a household override; current `auth.ts:130-143` reads
the authoritative role (admin or member) from the membership row. A reader would wrongly believe
admin actions can't cross a switch. _Fix:_ rewrite to the membership-row-authoritative model.

**M10. Security-critical frontend units are untested.** `authStore` session logic (`verifySession`,
the localStorage/sessionStorage token split, cross-tab logout listener) and the entire
`HouseholdSwitcher` (whose cache-invalidation underpins cross-household correctness) have no direct
tests. _Fix:_ add unit tests for both. — _(tests M3 + M4)_

**M11. No reserved concurrency on any Lambda; rollback doesn't revert infra.** A runaway chat/reminders
loop can exhaust the 1000 account-concurrency pool and brown out the whole API (alarm detects, nothing
prevents). Separately, auto-rollback reverts only lambda _code_, not the `terraform apply` that ran
first, and silently no-ops on a missing artifact. _Fix:_ `reserved_concurrent_executions` on
chat/chat-stream; document that infra isn't auto-rolled-back; fail loud on missing artifact. —
_(infra M1 + M2)_

**M12. Household scoping is doubly-specified (header + URL path).** Drives ~20 `householdId!`
non-null assertions each paired with a separate `enabled: !!householdId` guard; an unguarded copy
compiles silently. _Fix:_ pick one scoping mechanism. — _(tests M5)_

## LOW (grouped — hygiene / latent / scale-cliff)

- **Dead/Trap code:** `isApiKey` flag is set but never read (reads like an enforced control but isn't;
  actual protection is scope-based) — delete or wire it. `assignedTo`/lone-admin invariants are
  enforced in handlers, not the service layer (currently safe, fragile to a future handler).
- **Frontend perf/scale:** no list virtualization anywhere (fine at 10 plants, a cliff at the
  advertised 5,000-plant Greenhouse tier); `PlantsPage` recomputes a Set every render; dashboard
  date logic duplicates `utils/date.ts` and can disagree with the notification hook for a "due later
  today" window.
- **`streamMessage`** re-implements the axios auth-header scheme (will drift) and is untested, along
  with `parseProposalBlock`.
- **Infra low:** lambdas are x86 (arm64 = ~20% cheaper, one-line change); function-URL public grant is
  managed out-of-band (invisible to drift detection, fixed by the provider-6 dependabot PR); DLQ SSE
  not explicit; global (not per-route) API GW throttle; images bucket unversioned.
- **Tests:** visual-regression suite is CI-skipped (macOS baselines) but still ships snapshots ×5
  browsers; reminder dedupe tests are contract not concurrency tests (label them).
- **Consistency:** query-string construction differs across three frontend services (standardize on
  axios `params`); Plant.id upstream error text is reflected to the client (log server-side instead).
- **Deploy-readiness:** Stripe/Sentry/VAPID/GIT_SHA all default empty in prod tfvars, so billing
  checkout throws in prod if hit and web-push/Sentry are inert (matches the known provisioning gaps).

## Genuinely strong (verified, keep)

- Auth/authz: membership-row authoritative over JWT claim, validated `X-Household-Id` override re-checked
  even when header == claim, 60s cache with synchronous invalidation on role/member mutation.
- Stripe webhook: raw-body signature verify, apply-before-ledger ordering, out-of-order guard, 30-day
  TTL dedupe, never defaults to a paid plan — with adversarial tests (prototype-pollution, secret-leak).
- Plan-cap enforcement: atomic `TransactWrite` conditional counters with correct error mapping and
  legacy backfill. Reminder fan-out, chat tool loop, rate limiter, IDOR scoping, SSRF allowlist, API-key
  hashing/scopes: all correctly implemented and tested.
- Frontend: excellent type safety (zero `any`/`@ts-ignore` in `src/`), consistent household-scoped
  query keys across ~25 sites, textbook optimistic claim/unclaim, correct 401-refresh coalescing,
  careful image/CSV pipelines, good focus management.
- Infra: state-isolation landmine confirmed closed in all three places; tight OIDC trust policy;
  well-scoped lambda execution role; correct script-injection hygiene; no fork-triggered secret exposure;
  bounded retries + DLQ on all async paths.

## Recommended order of action

1. **H1** (DND reminder loss) — a live bug in the core product loop; fix first.
2. **H2 + H3** (overdue alerts cross-household, mobile drawer) — real user-facing bugs on the mobile +
   multi-household paths.
3. **H4 + H5** (gate prod terraform apply; close deploy-role self-escalation) — cheap, high-leverage
   security hardening now that the repo is public.
4. **M1 + M2** (paid-API spend cap; images-bucket lifecycle) — cost/abuse + data-retention.
5. **H7** (handlers↔main.tf route check) — cheap CI gate closing a silent-404 class.
6. **H6 / M9 / M10** (integration-suite-tests-a-clone; stale authz doc; untested auth units) — the
   maintainability/correctness-confidence backlog.
