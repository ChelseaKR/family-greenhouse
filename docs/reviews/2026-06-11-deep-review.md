# Deep Review — 2026-06-11

Consolidated output of a five-track review (code review, security red team, bug hunt,
performance/cost audit, product survey) of the production deployment at familygreenhouse.net.
All findings were verified against actual code paths; file:line references are relative to repo root.

---

## 1. Fix-first list (ordered)

### 🔴 P0 — Security, ship this week

**S1. Users can self-grant `household_role=admin` / `household_id=<any>` via Cognito self-service attribute writes.**
The app client's `write_attributes` includes `custom:household_id` and `custom:household_role`
(`infrastructure/modules/auth/main.tf:117-122`), and both schema attributes are `mutable = true`.
Any authenticated user can call the standard (non-admin) Cognito `UpdateUserAttributes` API with their
own access token, set `custom:household_role = admin` and `custom:household_id = <victim household UUID>`,
then `POST /auth/refresh` to mint a token the backend trusts blindly (`backend/src/middleware/auth.ts:82-88`
— the default claim path has no membership check; only the `X-Household-Id` override path is validated).
Household UUIDs leak via the public invite endpoints (`GET /households/invites/{code}` returns
`household.id`). Result: scriptable self-escalation to admin and full cross-household takeover
(read/write plants, tasks, billing, member removal, API key minting).
**Fix:** remove the two `custom:*` attributes from the app client `write_attributes` (one-line Terraform);
then, defense in depth, validate default-path claims against the membership table in `authMiddleware`
(same `getMemberByUserId` check the override path already does) or add a Pre-Token-Generation Lambda.

**S2. Climate endpoints have no household-membership check (IDOR, read + write).**
`backend/src/handlers/climate/handler.ts:24-31, 69-77` — `getClimate` never compares the path
`householdId` to the caller's; `setLocation` checks the caller is an admin _of their own household_ but
not of the path household. Any user can read any household's location/weather (where a family lives)
and overwrite/null any household's location. Every other household-scoped handler does this check;
this file is the outlier. **Fix:** `if (householdId !== user.householdId) throw 403` in both routes +
`requireHousehold()` on `getClimate`; add cross-household tests.

**S3. Rate limiter is fully bypassable and mis-keyed on the deployed payload format.**
`backend/src/middleware/rateLimit.ts:29-34` trusts the _leftmost_ `X-Forwarded-For` hop (client-controlled
— rotate a fake XFF per request for a fresh bucket, neutering `authRateLimit` on `/auth/login`), and reads
`event.requestContext.identity.sourceIp` / `event.path`, neither of which exists on the deployed
HTTP API payload format 2.0 (`infrastructure/modules/api/main.tf:348`) — real keys come out as
`"undefined|<spoofed>"`. Buckets are also never evicted (memory growth in warm containers).
**Fix:** use `event.requestContext?.http?.sourceIp` and `event.rawPath`; never trust the first XFF hop;
sweep expired buckets; add v2-shaped-event tests. For auth routes, a DDB conditional counter or WAF is
the only hard guarantee (in-memory limits multiply by Lambda concurrency).

**S4. Removed household members keep access for up to 1 hour.**
`backend/src/middleware/auth.ts:83-116` + `utils/membershipCache.ts:54-63` — the default claim path never
consults DynamoDB, so after `removeMember` the ejected user's token still works until expiry
(`id_token_validity = 1h`, `infrastructure/modules/auth/main.tf:125`). The doc comment claiming
"kicked-out user loses access on the very next request" is wrong. **Fix:** route claim-derived household
through the same cached membership check as the override path (~1 DDB read/user/min at the 60s TTL).
Fixing S1's defense-in-depth layer fixes this too — same change.

**S5. Unmetered paid-API endpoints (cost amplification).**

- `POST /plants/identify` (`backend/src/handlers/plants/identify.ts:25-38`): no `userRateLimit`, no plan
  gate, no fetch timeout — a looping account runs up the Plant.id bill at machine speed.
- `GET /species/*` (`backend/src/handlers/species/handler.ts`): proxies Perenual + Bedrock with no rate limit.
- `POST /notifications/run-reminders` (`handlers/notifications/handler.ts:131-143`): admin can trigger
  unbounded SMS/email fan-out on demand.
- Presigned S3 PUT (`handlers/plants/handler.ts:198-224`): no `content-length-range` — a user can PUT
  up-to-5GB objects repeatedly.
  **Fix:** `userRateLimit` on all four (mirror chat's 20/min pattern), AbortController timeout on the
  Plant.id fetch, presigned POST with size condition (≤5 MB), daily SMS cap per household.

### 🔴 P0 — Correctness, actively wrong in production

**B1. Reminders re-send up to 24×/day per task.** Hourly EventBridge rule + 24h due-window + no
"already reminded" marker anywhere (`backend/src/services/reminders.ts:18,41`;
`infrastructure/modules/api/main.tf:479`). Email/SMS users get the same reminder every hour until the
task is completed — SMS is billed per message. **Fix:** TTL'd per-user dedupe row
(`PK=USER#{id}, SK=REMINDED#{yyyy-mm-dd}`) or `lastRemindedAt` skip-if-<20h.

**B2. Chat breaks after any tool use.** `tool_result` turns are never persisted
(`backend/src/services/chat/index.ts:262-266` vs persistence at `:148/:185`), so the next turn replays an
assistant `tool_use` with no matching `tool_result` and Bedrock rejects the request. Since the system
prompt pushes tool use, most conversations hard-fail on message two. Invisible to tests because
`chatTurn.test.ts` mocks history as `[]`. **Fix:** `appendMessage` the tool_result content where
`messagesForModel` is extended; make `trimHistory` pair-aware; add a multi-turn replay test.

**B3. Task reassignment never updates GSI2 / `assignedToName`.**
`backend/src/services/taskService.ts:205-209` vs `createTask:74-77` — reassigned tasks stay in the old
assignee's GSI2 partition forever: reminders go to the wrong person, "assigned to me" views are wrong,
`GSI2SK` drifts from `nextDue` on update/complete. **Fix:** SET/REMOVE GSI2 keys + re-resolve
`assignedToName` whenever `assignedTo` or `nextDue` changes.

**B4. Stripe webhook idempotency ledger written _before_ the state change.**
`backend/src/services/billing.ts:238-246` — if `updateHouseholdSubscription` throws after
`recordStripeEventOnce`, Stripe's retry is skipped as a duplicate and the plan change is silently lost
(household keeps paid features after cancellation, or never gets the plan they paid for).
**Fix:** invert the order or use a TransactWrite. Also guard out-of-order delivery by comparing
`event.created` against stored state (a late `subscription.updated` can resurrect a canceled plan).

**B5. Member removal / account deletion corrupts multi-household state.**
`handlers/households/handler.ts:348,393-394` — `removeMember` unconditionally `clearHouseholdClaims`,
wiping the user's pointer to a household they're _still in_; `updateMemberRole` silently switches their
default household. `DELETE /me` (`handlers/me/handler.ts:59-66`) cleans only the active household —
ghost member rows everywhere else, possible admin-less locked households, and API keys / prefs / push
subscriptions survive a GDPR erasure request. **Fix:** mutate claims only when the affected household
matches the claim household; iterate `getMembershipsByUser` in deleteMe with the lone-admin guard;
delete prefs/subscriptions/keys.

### 🟠 P1 — High-value bugs

| #   | Bug                                                                                                                          | Where                                                | Fix                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| B6  | `completeTask` non-idempotent; missing `attribute_exists` can resurrect deleted tasks as ghost rows                          | `taskService.ts:276-347`                             | condition expression + idempotency guard                                                              |
| B7  | Tasks for died/gave-away plants still appear in lists, overdue counts, and the ICS calendar (only reminders filter)          | `taskService.ts:102-176`, `me/handler.ts:165-186`    | filter by active-plant set or pause tasks on lifecycle transition                                     |
| B8  | 401-refresh: concurrent requests fail instead of queueing behind the in-flight refresh                                       | `frontend/src/services/api.ts:75-100`                | shared refresh promise + retry queue                                                                  |
| B9  | Opening a new tab after token expiry logs out every tab (sessionStorage refresh token + storage-event cascade)               | `authStore.ts:59,98-116,244-280`                     | don't rewrite shared localStorage from a tab with no refresh token                                    |
| B10 | CSV formula injection in export (`=HYPERLINK(...)` in a plant name executes in Excel for другого member)                     | `frontend/src/utils/csv.ts:7-11`                     | prefix `=+-@`/tab/CR cells with `'`                                                                   |
| B11 | Plan caps are check-then-write races (plants, members, double-join overwrites admin role to member)                          | `plants/handler.ts:54-62`, `householdService.ts:300` | conditional writes / `attribute_not_exists` on member Put                                             |
| B12 | `computeStreak` shows long-dead streaks as current (never compares newest completion to now)                                 | `frontend/src/utils/streaks.ts:11-35`                | require `now - newest ≤ frequency × 1.5`                                                              |
| B13 | Overdue browser notifications re-fire the entire batch on every dashboard mount                                              | `frontend/src/hooks/useOverdueAlerts.ts:11-27`       | seed `announced` on first data without notifying                                                      |
| B14 | `updateProfile` trusts raw `X-Cognito-Access-Token` without subject match — can update Cognito and DDB for _different_ users | `handlers/auth/handler.ts:345-387`                   | `GetUser(AccessToken)` sub-compare; add authRateLimit                                                 |
| B15 | Analytics truncate at 200 items (year-in-review, plant-cap check can never trip on paid tiers)                               | `taskService.ts:470,529`, `plantService.ts:105`      | paginate with `LastEvaluatedKey`                                                                      |
| B16 | Snooze adds days to old `nextDue` — snoozing a 10-days-overdue task leaves it 9 days overdue                                 | `taskService.ts:357-361`                             | base on `max(now, nextDue)`                                                                           |
| B17 | Bad IANA timezone string aborts reminders for all later members, error swallowed silently                                    | `notificationPrefs.ts:94-99`, `reminders.ts:70-73`   | validate via `Intl.supportedValuesOf`, try/catch + log                                                |
| B18 | Pest-alert month matching treats the word "may" as the month May                                                             | `services/pestAlerts.ts:51-59`                       | word-boundary regex (also: `evaluatePestAlerts` has no caller — the prefs toggle is wired to nothing) |
| B19 | Transient Secrets Manager failure caches Perenual key as 'unset' for container lifetime                                      | `services/perenual.ts:75-100`                        | only cache genuine absence                                                                            |
| B20 | DST off-by-one in relative-day labels; HouseholdSwitcher misses `api-keys` invalidation (query keys not household-scoped)    | `utils/date.ts:23,34`, `HouseholdSwitcher.tsx:72-87` | round/UTC-noon; embed householdId in query keys                                                       |

### 🟠 P1 — Local mock drift (the reason CI can't catch the above)

`backend/src/local-server.ts` inverts the production `X-Household-Id` security check (scopes to _any_
named household — `local-server.ts:283-290` vs `auth.ts:107-108`), returns JSON error bodies where
production returns text/plain (frontend error extraction silently degrades in prod —
`frontend/src/services/api.ts:125`), returns tokens from `/auth/confirm` (production doesn't), skips Zod
validation entirely, and implements a join route that doesn't match production's path. Integration tests
test the mock, so this entire drift class is structurally invisible — `local-server.test.ts:753-770`
asserts a 200 for a request production 403s. **Fix:** import the real `models/schemas.ts` into the mock,
align auth/error/join contracts, generate per-route contract tests from the exported `routes` arrays.

---

## 2. Optimization plan (ranked by impact ÷ effort)

Context: ~$2–3/mo run-rate, tiny data volume. Dollar wins are small; the real wins are two broken image
paths, write-path latency, cold starts, and one scaling cliff.

### Quick wins (≤ a day each)

1. **Plant photos are served from blocked S3 URLs** — handler mints raw
   `https://{bucket}.s3.amazonaws.com/plants/...` (`plants/handler.ts:221`) but the bucket is
   CloudFront-only, and the CloudFront `/images/*` behavior never matches keys under `plants/` —
   so user photos likely 403 in production and the cache behavior is dead. Fix: path pattern → `/plants/*`,
   mint URLs as `https://familygreenhouse.net/plants/...`. While there: the presign hardcodes
   `image/jpeg` + `.jpg` but the UI accepts PNG/WebP — non-JPEG uploads fail signature validation.
2. **Species thumbnails always 401** — `<img>` can't send a JWT, but `/species/{id}/thumbnail` is behind
   the JWT authorizer (`api/main.tf:432`). Flip to `auth = "none"` or return `thumbnailUrl` in the JSON
   and let the browser hit Perenual's CDN directly.
3. **Inline Cognito `AdminGetUser` on every plant write** (`plants/handler.ts:74,150,263`) — ~100ms of
   critical-path latency for a name already denormalized on the `HouseholdMember` row. Read it from DDB.
4. **Serial awaits**: `Promise.all` the independent reads in `createPlant` (`plants/handler.ts:54-56`);
   TransactWrite the Put+Update pair in `completeTask` (also fixes B6).
5. **CloudWatch alarm sprawl** — 31 alarms (~$2/mo ≈ the rest of the stack combined), most on
   zero-invocation functions (`monitoring/main.tf:238-283`). Two aggregate metric-math alarms + per-function
   only on `reminders`/`chat`.
6. **S3 versioning with no lifecycle expiry** on the frontend bucket — every deploy adds ~9 MB forever.
   Add a 30-day noncurrent-version expiry rule.

### Medium effort

7. **Lambda bundle hygiene** — every handler ships ~1 MB (chat 3.1 MB): Stripe SDK is inside `plants.js`
   (via top-level import in `billing.ts:1`; dynamic-import inside `getStripe()`), Sentry is statically
   imported everywhere (`utils/sentry.ts:1`; gate behind `SENTRY_DSN`). Un-externalize AWS SDK v3 in
   `esbuild.config.js:44-50` (bundling v3 is faster than loading the runtime copy). Bump hot handlers
   256→512 MB (CPU scales with memory; cost delta ≈ $0 at this traffic). Expect −100–300 ms per cold start.
8. **Reminders cron is the one true scaling cliff** — full-table Scan (`householdService.ts:168-187`)
   - per-household serial member/plants/per-member-GSI2/prefs reads, hourly. Replace with one GSI1
     due-window query per household grouped in memory, plus a sparse household-directory GSI to kill the Scan.
9. **Client-side image downscaling** — 5 MB originals rendered into 200px grid cells; canvas-resize to
   ≤1600px WebP before the presigned PUT (~40 lines, 10–30× bandwidth cut, pairs with #1).
10. **Optional structural**: `GET /dashboard` aggregate endpoint (5 round trips → 1); CloudFront in front
    of API Gateway (also re-enables WAF, which can't attach to HTTP APIs directly).

Already well-tuned: on-demand DDB, 30-day log retention, PriceClass_100, route-level code splitting,
budget + anomaly alerts, no hot partitions, no scans on request paths.

---

## 3. Test-coverage gaps (what would have caught the above)

- **Untested handlers (6/14):** chat, plants/identify, apiKeys, species (the thumbnail host allowlist is a
  security control with zero tests), notifications, reminders; the entire `/api/v1/*` public-API layer.
- **Untested middleware:** `rateLimit.ts` (riskiest module), `apiKey.ts`, `logging.ts`, `membershipCache.ts`.
- **Untested risky branches:** X-Household-Id override path, multi-turn chat replay after tool use,
  Stripe apply-failure, updateTask GSI2, consecutive-hour reminder idempotency, cross-household climate,
  deleteMe multi-household, any 429 path.
- **Structural:** integration tests import the Express mock, not the handlers — drift is invisible.
  Generate contract tests from `createRouter`'s exported route tables.

## 4. Done well (keep doing these)

- Stripe webhook signature path: raw-body preservation, base64 handling, verify-before-state-change.
- External-API discipline in `perenual.ts`/`weather.ts`: never-throw clients, AbortController timeouts,
  DDB cache, atomic TTL'd daily-budget circuit breakers.
- API key design: 192-bit entropy, SHA-256-hashed at rest, scoped, greppable `fg_` prefix, shown once.
- Invite tokens: 128-bit, 7-day TTL, single-use, validate endpoint rate-limited.
- No injection vectors: all DDB access parameterized; no secrets in the repo; S3 fully locked down;
  scoped IAM (except the acknowledged AdministratorAccess CI/CD role — L2).
- Comment quality is well above average — which is exactly why the handful of now-false comments
  (auth revocation claim, rate-limit per-route claim, "tests guarantee" in taskTemplates) matter.

---

## 5. Feature ideation roadmap

North-star metrics (docs/roadmap.md): plant survival ≥95% @ 90 days · task completion ≤24h ≥75% ·
active members/household ≥1.5. Tiers: Seedling (free, 10 plants/1 member) · Garden ($4.99, 500/6) ·
Greenhouse ($9.99, 5000/50).

### Horizon 0 — Stabilize (weeks 1–2)

Ship the P0 security + correctness fixes above before any feature work. The reminder spam (B1) and
broken images (Opt #1) are actively degrading the experience of every real user today, and S1 is a
scriptable account-takeover. Also: exit beta deliberately — `VITE_BETA_MODE` currently hides pricing;
flipping it is the monetization launch and should follow the Stripe webhook fix (B4).

### Horizon 1 — Retention loop (month 1–2) · drives task-completion + survival metrics

All four are flagged implementation-ready in docs/roadmap.md; the data layer already exists:

1. **Weekly "plants at risk" digest** (email) — analytics exist (`plants-at-risk` ranking already on the
   dashboard); needs template + schedule. The single highest-leverage retention feature: it re-engages
   lapsed users with a loss-aversion hook.
2. **CSV/JSON import** — kills the cold-start problem for new households with existing collections;
   validators exist, UI doesn't. Gate import size by plan tier (natural upgrade nudge).
3. **End-of-year recap email** — year-in-review aggregation exists; template + EventBridge schedule.
   Shareable artifact → organic acquisition.
4. **Smart snooze/reschedule from climate** — `deriveClimateTips` already computes "rain expected, skip
   watering"; wire it into the task list as a one-tap "skip this cycle, it rained" action. Differentiator
   no competitor has, and the data is already flowing.

### Horizon 2 — Collaboration & AI (month 2–4) · drives members/household ≥1.5

5. **Chat V1** — fix B2, then ship the deferred `propose_reminder_task` write tool with a confirm-card UI,
   and streaming via Lambda Function URL. The chat is the Greenhouse-tier anchor feature; today it breaks
   on turn two.
6. **Task claiming + fair-share view** — tasks with no assignee are currently never reminded to anyone
   (verified gap in `remindHousehold`). Add "up for grabs" tasks any member can claim, and a per-member
   contribution view (data already in year-in-review). This is the feature that makes a _family_ app
   rather than a solo app with viewers.
7. **Care handoff / vacation mode** — temporarily reassign all of one member's tasks for a date range.
   Cheap on the existing GSI2 model once B3 is fixed; extremely high perceived value.
8. **Phone verification for SMS** (closes the docs TODO) + quiet-hours polish.

### Horizon 3 — Monetization depth (month 4–6)

9. **Plant.id identification as a metered Garden/Greenhouse perk** — it's a paid API with no plan gate
   today (S5). Free tier: 3 IDs/month; paid: more. Turns a cost center into an upgrade driver.
10. **Public API writes + OAuth** (Y2Q4 gate) → unlocks Home Assistant / smart-sensor integrations.
    A read-only Home Assistant card is shippable _now_ against the existing API as a community appetizer.
11. **Downgrade-overage UI** (documented gap): "over limit" banner + read-only-above-cap behavior.
12. **Propagation tracker** — cuttings as child plants with lineage (PLANT# rows + parent pointer fit the
    single-table design cheaply). Plant people obsess over this; nothing mainstream serves it.

### Horizon 4 — Big bets (month 6–12, validate before building)

13. **CV health detection** (Y3 theme) — start narrow: "is this leaf yellowing?" classifier on the photo
    timeline, surfaced as a care suggestion, before attempting general diagnosis.
14. **Community cutting exchange** (Y3 marketplace theme) — start as household-to-household invite-based
    sharing of plant cards, not a marketplace; measure pull before building trade mechanics.
15. **B2B greenhouse mode** — a Greenhouse-tier household with 50 members and 5000 plants is already
    structurally a small nursery; pilot with one real nursery before designing anything.

### Explicitly deprioritized

- Household payment splits (Stripe doesn't support it natively; no usage signal yet — keep deferred).
- More i18n locales before retention features (infra is ready; content can wait for demand).
- RAG corpus for chat (tool-use over live data covers the MVP; corpus adds ops burden for marginal gain).
