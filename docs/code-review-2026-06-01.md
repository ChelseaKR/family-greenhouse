# Family Greenhouse — whole-repo code review (2026-06-01)

Reviewer: read-only audit. No source/Terraform/deploy changes. Security findings are excluded — see `docs/security-review-2026-05-31.md`.

Scope: backend (`backend/src`), frontend (`frontend/src`), infrastructure (`infrastructure/`), docs (`docs/`). `tsc --noEmit` is green for both packages. `npm audit` / `npm outdated` could not be run — the sandbox refused outbound network calls.

## TL;DR

The codebase is in good shape — auth model is sound, handler boilerplate is uniform within each group, type checking is green on both packages with very few escape hatches. The most consequential issues are operational drift rather than internal quality problems: **(1) two endpoints the frontend calls (`POST /plants/identify`, `POST /notifications/run-reminders`) are not wired in production routes or Terraform, so they 404 silently in prod**; **(2) Sentry is imported and wrapped but never actually `instrument()`-applied to any handler — unhandled Lambda errors are reaching CloudWatch only**; **(3) several runtime env vars are referenced in code (`STRIPE_*`, `SES_FROM_EMAIL`, `PLANT_ID_API_KEY`, `WEB_PUSH_VAPID_*`, `SENTRY_DSN`) but never set in the Terraform Lambda environment** (possibly set out-of-band, but a drift signal); **(4) the drift-guard test for the router uses a regex that only matches `// METHOD /path` comments, so it silently misses the JSDoc-style route docs and is the reason (1) wasn't caught**; **(5) there's substantial duplication of path-param-required checks (~21 occurrences) and JSON-body re-parsing (~4 occurrences) that the validation middleware already abstracts.** Everything else is small.

Findings ordered by severity below. A consolidated fix-order table is at the bottom.

---

## 1. `POST /plants/identify` is 404 in production

**Severity: high.** API design / dead code.

**Evidence:**

- Handler: [`backend/src/handlers/plants/identify.ts`](../backend/src/handlers/plants/identify.ts) exports `identify` — but it's a sibling file to `handler.ts`, not part of the `plants` group's router map ([`backend/src/handlers/plants/handler.ts:299`](../backend/src/handlers/plants/handler.ts)).
- The esbuild config only includes files literally named `handler.ts` ([`backend/esbuild.config.js:15`](../backend/esbuild.config.js)), so `identify.ts` is never bundled into any Lambda artifact.
- No API Gateway route exists for it ([`infrastructure/modules/api/main.tf:303-312`](../infrastructure/modules/api/main.tf) — `plants` block has 9 routes, no `identify`).
- Frontend calls it anyway: [`frontend/src/services/plantService.ts:157`](../frontend/src/services/plantService.ts) — `POST /plants/identify`.

**Effect:** The plant-identification feature is dead in production — every UI invocation returns 404 from API Gateway. The frontend's `identifyPlant` returns a rejection that callers route into the same error toast as any other failure, so the regression isn't obvious from a user log-in.

**Fix:** Either (a) wire `identify` into the `plants` router (`'POST /plants/identify': identify`) and add the route to Terraform's `local.routes`; or (b) if the feature is intentionally shelved, remove the dead handler + frontend `plantService.identifyPlant` + `IdentifyResponse` types + the Plant.ID env vars/code path in `services/plantIdentification.ts`. The "shipped but broken" middle state is the worst.

---

## 2. `POST /notifications/run-reminders` is 404 in production

**Severity: high.** API design / dead code.

**Evidence:**

- Handler exists and is fully implemented: [`backend/src/handlers/notifications/handler.ts:130`](../backend/src/handlers/notifications/handler.ts) — exports `runReminders`.
- But the route is NOT in the `notifications` group's router map ([`backend/src/handlers/notifications/handler.ts:145-150`](../backend/src/handlers/notifications/handler.ts) only registers prefs/subscribe/unsubscribe).
- And it's NOT in Terraform's `local.routes` ([`infrastructure/modules/api/main.tf:346-349`](../infrastructure/modules/api/main.tf) — notifications block has 4 routes, no run-reminders).
- Frontend calls it: [`frontend/src/services/notificationService.ts:34`](../frontend/src/services/notificationService.ts) (`api.post('/notifications/run-reminders')`).

**Effect:** Any "send reminders now" button in the UI returns 404. The hourly EventBridge scan (`handlers/reminders/handler.ts`) still works, so the feature isn't broken end-to-end — but the manual override is.

**Fix:** Add the route to both the dispatcher map and `local.routes`. Or remove the dead frontend method + the un-routed handler export.

---

## 3. Drift-guard test misses JSDoc route comments

**Severity: medium.** Testing quality.

**Evidence:** [`backend/tests/unit/middleware/router.test.ts:76`](../backend/tests/unit/middleware/router.test.ts) — the regex is `^\/\/\s*(GET|POST|...)\s+(\/\S+)`, which only matches `// METHOD /path` style comments. The `notifications` handler documents `runReminders` as `* POST /notifications/run-reminders` inside a JSDoc block — that line begins with `*`, not `//`, so the test passes despite the route being unregistered.

**Effect:** This is the test that should have caught Findings 1 and 2. As-is it gives false confidence — "all documented routes are dispatched" is a vacuously-true statement for routes documented in JSDoc.

**Fix:** Extend the regex to also match `^\*\s*(GET|...)` lines, or scrape route strings from the `createRouter({ ... })` literal AND cross-reference against `infrastructure/.../main.tf` so the test fails when the frontend service calls a path no production route handles. The latter is more work but kills a whole bug class.

---

## 4. Sentry is imported but never wired up

**Severity: medium.** Dead code / observability gap.

**Evidence:**

- [`backend/src/utils/sentry.ts`](../backend/src/utils/sentry.ts) defines `initSentry()` and `instrument(handler)`.
- Neither is imported anywhere outside the file itself (`grep -rn "initSentry\|instrument(" backend/src` returns only `utils/sentry.ts`). `createHandler` in [`backend/src/middleware/handler.ts`](../backend/src/middleware/handler.ts) builds the middy stack with no Sentry wrapping.
- `@sentry/aws-serverless` is in `backend/package.json` dependencies and contributes to the bundle size on every Lambda even though it does nothing.
- `SENTRY_DSN` is referenced in code but not declared in Terraform Lambda env (see Finding 5).

**Effect:** Unhandled exceptions (5xx from a thrown non-`createHttpError`) only show up in CloudWatch logs — there's no Sentry issue created, no alerting wired through it. The frontend has `sentry.ts` initialized but the backend half of the loop is missing.

**Fix:** In `createHandler` / `createRawBodyHandler`, wrap the final middy chain with `instrument(...)`. Or remove the Sentry code + dependency to stop carrying ~150 KB of dead code per Lambda bundle.

---

## 5. Env vars referenced in backend code but not in Terraform Lambda env

**Severity: medium.** Documentation / infrastructure drift.

**Evidence:** Backend code references these `process.env.*`:

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_GARDEN`, `STRIPE_PRICE_ID_GREENHOUSE` (`services/billing.ts`, `models/plans.ts`)
- `SES_FROM_EMAIL` (`services/emailNotifier.ts`)
- `PLANT_ID_API_KEY` (`services/plantIdentification.ts`)
- `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT` (`services/notifier.ts` neighborhood)
- `SMS_NOTIFICATIONS_ENABLED` (`services/smsNotifier.ts`)
- `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `GIT_SHA`, `APP_VERSION` (`utils/sentry.ts`, `utils/logger.ts`)
- `CHAT_BUDGET_INPUT_TOKENS`, `CHAT_BUDGET_OUTPUT_TOKENS` (`services/chat/index.ts`)

The Terraform Lambda environment ([`infrastructure/modules/api/main.tf:217-235`](../infrastructure/modules/api/main.tf)) only sets `NODE_ENV`, `TABLE_NAME`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `IMAGES_BUCKET`, `ALLOWED_ORIGIN`, `FRONTEND_URL`, `BEDROCK_CHAT_MODEL_ID`, `BEDROCK_INPUT_USD_PER_MTOK`, `BEDROCK_OUTPUT_USD_PER_MTOK`. No Stripe, no SES, no VAPID, no Sentry.

**Effect:** Stripe and webpush degrade silently to no-op-or-throw behavior depending on which call hits an unset key. `services/billing.ts:17` throws `STRIPE_SECRET_KEY is required` the moment anyone hits checkout, which would be very visible — so they must be set out-of-band (AWS console / SSM / a script not in this repo). That out-of-band path isn't documented and isn't reproducible from a fresh terraform apply. Most concerning: the Stripe price-ID env vars are required for `checkout` to succeed at all.

**Fix:** (a) Declare these vars in `infrastructure/modules/api/variables.tf` and pass them through `aws_lambda_function.handlers.environment.variables`, OR (b) document the post-deploy SSM/secrets-manager workflow in `docs/deployment.md` and add a Terraform `aws_ssm_parameter.X` reference per secret. Either is fine, "everyone just remembers" isn't. The Stripe ones in particular are required-or-throw and should not depend on operator memory.

---

## 6. `POST /chat/conversations` route is referenced in docs but doesn't exist

**Severity: low.** Documentation drift.

**Evidence:** [`backend/src/handlers/chat/handler.ts:5`](../backend/src/handlers/chat/handler.ts) — the file-level JSDoc lists `GET /chat/conversations — list conversations the user can see` as one of three routes, but only three other routes exist (`POST /chat/messages`, `GET /chat/conversations/{id}/messages`, `GET /chat/budget`) and `GET /chat/conversations` (no `{id}`) isn't dispatched anywhere.

`docs/api-spec.yaml` is also missing all `/chat/*` endpoints, all `/plants/identify`, and all `/notifications/run-reminders`. Search for `chat` / `identify` / `run-reminders` in the spec returns zero hits.

**Fix:** Fix the JSDoc to match the three actual routes. Regenerate `api-spec.yaml` from the route map (or hand-update it) to include chat + the public API surface. The spec is a sales artifact for the public API plan — it shouldn't lag the actual surface.

---

## 7. Path-param-required checks duplicated ~21× across handlers

**Severity: low.** Duplication.

**Evidence:** Search `throw createHttpError(400, 'X ID is required')` across `backend/src/handlers/` yields 21 occurrences: 7 in plants, 6 in tasks, 7 in households, 1 in api. Every handler that takes a path param starts with the same 3 lines:

```ts
const plantId = event.pathParameters?.id;
if (!plantId) {
  throw createHttpError(400, 'Plant ID is required');
}
```

The `middleware/validation.ts` file already exports `validatePathParams` but it's never used (see Finding 11). API Gateway will always populate `event.pathParameters` for a matched route — the check is genuinely "TypeScript narrowing" not "runtime defence" — but it's still 21 nearly-identical sites.

**Fix:** Either (a) add a tiny helper:

```ts
function requirePathParam(event: APIGatewayProxyEvent, name: string, label = name): string {
  const v = event.pathParameters?.[name];
  if (!v) throw createHttpError(400, `${label} is required`);
  return v;
}
```

and use it. Or (b) actually adopt `validatePathParams(plantIdParamSchema)` from `middleware/validation.ts` for every routed handler. Either drops ~60 LOC of boilerplate and removes the "TypeScript thinks plantId might be undefined" branch.

---

## 8. Cross-household 403 checks duplicated 7× in `households` handler

**Severity: low.** Duplication.

**Evidence:** [`backend/src/handlers/households/handler.ts`](../backend/src/handlers/households/handler.ts) lines 82, 115, 261, 282, 300, 326, 375 — every route that takes `:id` (or `:householdId`) does:

```ts
if (user.householdId !== householdId) {
  throw createHttpError(403, 'Access denied');
}
```

This is correctness-critical, not stylistic — the BAC-fix relies on this check happening on every route. Centralising it removes the risk of forgetting it on the next added route.

**Fix:** Pull out a `requireHouseholdAccess` middleware that reads `event.pathParameters?.id || event.pathParameters?.householdId` and compares it to `event.user.householdId`. Stack it after `requireHousehold()`. Cleaner and audited-in-one-place.

---

## 9. Manual JSON-body parsing in handlers instead of `validateBody`

**Severity: low.** Inconsistency.

**Evidence:** Four handlers parse the body manually instead of using `validateBody(schema)`:

- `completeTask` ([`tasks/handler.ts:172-182`](../backend/src/handlers/tasks/handler.ts)) — even though `completeTaskSchema` exists in `models/schemas.ts:94` and is otherwise dead.
- `applyTemplate` ([`tasks/handler.ts:288-294`](../backend/src/handlers/tasks/handler.ts))
- `applyTemplateBulk` ([`tasks/handler.ts:229-237`](../backend/src/handlers/tasks/handler.ts))
- `confirmImageUpload` ([`plants/handler.ts:221-228`](../backend/src/handlers/plants/handler.ts))

Each has its own type assertion (`as { notes?: string }` etc.) and its own try/catch around `JSON.parse`. The body parser middleware (`httpJsonBodyParser`) already runs in `createHandler`, so `event.body` is always either an object or `null` by the time these handlers see it — the `if (typeof rawBody === 'string') JSON.parse(...)` branch is unreachable for routes wrapped by the standard `createHandler`.

**Fix:** Define schemas for these bodies (the first one is `completeTaskSchema` — already exists!) and apply `validateBody(...)`. Removes ~40 LOC and one bug class. As a bonus the un-defined `completeTaskSchema` becomes live.

---

## 10. Dashboard `completeTaskMutation` swallows errors silently

**Severity: low.** Frontend ergonomics.

**Evidence:** [`frontend/src/features/dashboard/DashboardPage.tsx:133-146`](../frontend/src/features/dashboard/DashboardPage.tsx):

```ts
const completeTaskMutation = useMutation({
  mutationFn: (taskId: string) => taskService.completeTask(taskId),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  },
});

const handleCompleteTask = async (taskId: string) => {
  try {
    await completeTaskMutation.mutateAsync(taskId);
  } catch {
    // Error is handled by the mutation
  }
};
```

The mutation has no `onError`. The comment is wrong — nothing handles the error. On a 500 or 402 (plan cap), the user clicks "Complete" and absolutely nothing happens.

Survey of frontend mutations: 47 uses of `useMutation`, only 7 with `onError`. The pattern is generally "let the caller's `try { mutateAsync } catch { setError(...) }` handle it" — but several call sites (dashboard, tasks listing, household member-role-change in places) don't carry that catch over.

**Fix:** Wire `onError` on the mutation that sets a page-level error, or use the `mutation.error` field to render an inline alert next to the task button. Better: standardise on a `useStandardMutation` wrapper that always sets a toast/banner on error so this is one decision not 47.

---

## 11. Dead exports in schemas, response utils, services

**Severity: low.** Dead code.

**Evidence:** `grep -rln` shows the following exports are never imported in production code (only in `models/schemas.ts` itself or in `local-server.ts` which is `@ts-nocheck` and not deployed):

- [`backend/src/models/schemas.ts`](../backend/src/models/schemas.ts): `joinHouseholdSchema`, `completeTaskSchema`, `idParamSchema`, `plantIdParamSchema`, `householdIdParamSchema`, `userIdParamSchema`, `inviteCodeParamSchema`, `taskFiltersSchema`, plus types `JoinHouseholdInput`, `CompleteTaskInput`. (`taskFiltersSchema` has a usage of its type alias `TaskFilters` — keep the type, remove the schema.)
- [`backend/src/utils/response.ts:27`](../backend/src/utils/response.ts): `errorResponse` — never called; everywhere uses `throw createHttpError(...)` and the http-error-handler middleware does the rest.
- [`backend/src/middleware/validation.ts:45-85`](../backend/src/middleware/validation.ts): `validatePathParams`, `validateQueryParams` — never used.
- [`backend/src/services/plantService.ts:421`](../backend/src/services/plantService.ts): `updatePlantImage` — superseded by `appendPlantPhoto`; only the deprecation comment + tests still reference it.
- [`backend/src/services/pestAlerts.ts:95`](../backend/src/services/pestAlerts.ts): `evaluatePestAlerts` — exported, never called (notification preferences expose a `pestAlerts` toggle in `notifications/handler.ts` but nothing actually reads it server-side beyond storing the flag).

**Fix:** Delete them. They confuse new contributors (which `validateBody` family member do I use? Both! — but actually neither pathParams/queryParams is wired anywhere).

---

## 12. `getDailyAnalytics` defined twice with subtly different code

**Severity: low.** Naming consistency.

**Evidence:** Both [`backend/src/handlers/households/handler.ts:277`](../backend/src/handlers/households/handler.ts) and [`backend/src/services/taskService.ts`](../backend/src/services/taskService.ts) `getDailyCompletionCounts` cover the same surface. The handler is well-named (`getDailyAnalytics`); the service function is named `getDailyCompletionCounts`. Internally that's fine, but the route is called `analytics/daily` and the function is called `completion counts` — a future reader has to chase three names for one thing.

Same for `taskService.MAX_QUERY_LIMIT` (private constant in tasks file, value 200) vs `plantService.MAX_QUERY_LIMIT` (exported but only used in the same file, value 200) — same constant, two places, one exported, one not.

**Fix:** Rename `getDailyCompletionCounts` → `getDailyAnalytics` to match the handler, and either inline both `MAX_QUERY_LIMIT`s or hoist to a shared `services/constants.ts`. Either way un-export the plant one.

---

## 13. Source maps emitted but `NODE_OPTIONS=--enable-source-maps` not set

**Severity: low.** Build health.

**Evidence:** [`backend/esbuild.config.js:38`](../backend/esbuild.config.js) builds with `sourcemap: true`, producing `.js.map` next to every bundle. Lambda environment ([`infrastructure/modules/api/main.tf:217-235`](../infrastructure/modules/api/main.tf)) doesn't set `NODE_OPTIONS=--enable-source-maps`. Node 20 needs this flag to use source maps when reporting stack traces — without it, the source map sits there unused and stack traces in CloudWatch point at minified column offsets in `dist/plants.js`.

**Fix:** Add `NODE_OPTIONS = "--enable-source-maps"` to the Lambda env. Trivial; payoff is every future production stack trace becomes readable.

---

## 14. AWS SDK bundling — bedrock/ses/sns not in externals

**Severity: low → monitor.** Build health.

**Evidence:** [`backend/esbuild.config.js:43-49`](../backend/esbuild.config.js) externalises `@aws-sdk/client-dynamodb`, `lib-dynamodb`, `client-cognito-identity-provider`, `client-s3`, `s3-request-presigner`. Code now also uses `@aws-sdk/client-bedrock-runtime` (chat), `@aws-sdk/client-ses` (email notifier), `@aws-sdk/client-sns` (sms notifier) — none of them externalised. They'll be bundled into every Lambda that touches them.

Three concerns: (a) cold-start time grows; (b) the `chat` Lambda is the heaviest and now also has bedrock bundled inside the bundle plus xray; (c) other Lambdas that touch nothing from bedrock still get bedrock pulled if any code path transitively imports the file — tree-shaking ESM dynamic imports is iffy. Inspect each `dist/*.js` for size before deciding.

There's also the question of whether the existing externals are _actually_ resolved by the Lambda runtime — Node 20 ships some AWS SDK v3 modules pre-installed but the list is shorter than v18's. Production works, so it's currently fine, but this is the kind of "works until AWS quietly changes a runtime contract" gotcha worth a periodic check.

**Fix:** Either (a) externalise the rest too (so the deployed bundle is small and relies on AWS-provided client modules — verify the Node 20 runtime really has them), or (b) explicitly bundle everything (drop the externals list entirely, trust the bundler, and stop guessing at the runtime contract). The current half-and-half is the worst of both worlds.

---

## 15. Doc-comment drift on `services/api.ts`

**Severity: info.** Documentation drift.

**Evidence:** [`frontend/src/services/api.ts:5`](../frontend/src/services/api.ts) — the file-level comment says `attach Authorization: Bearer <accessToken>`, but the implementation at line 35 reads `state.idToken ?? state.accessToken`. This was missed in the recent ID-vs-access-token split (per `currentDate` context). Easy fix; just update the comment to "ID token (falling back to access token for pre-split persisted sessions)".

---

## 16. Cognito user-name fetch fans out N+1 per export

**Severity: info.** Performance.

**Evidence:** [`backend/src/handlers/me/handler.ts:96-112`](../backend/src/handlers/me/handler.ts) — `exportMe` iterates `memberships` with `Promise.all`, calling `cognitoUsers.getUserName(...)` once per row before. No call to `getUserName` here actually, but the pattern shows up in `createPlant` (`activity.recordActivity({ actorName: await cognitoUsers.getUserName(userId, email) })`) on every plant create. Each `getUserName` is an `AdminGetUser` call against Cognito (or an in-Lambda cache miss). For a user creating plants quickly this is one extra Cognito read per write — and the user name only changes when they update their profile.

**Fix:** Add a 5-minute in-warm-container memo on `getUserName(userId)`. Same pattern as the membership cache in `middleware/auth.ts`. The function already falls back to the email local-part, so a stale cache is harmless.

---

## 17. Chat handler comment promises an unimplemented route

Same as Finding 6 — the chat handler's file-level comment lists three routes but actually exposes a different three (`messages`, `conversations/{id}/messages`, `budget`). The first one in the comment is `GET /chat/conversations` (no `{id}`) which doesn't exist. Confusing for the next reader.

---

## 18. `client_period_end` workaround relies on `as unknown` cast in Stripe code

**Severity: info.** Type safety.

**Evidence:** [`backend/src/services/billing.ts:178`](../backend/src/services/billing.ts) — `(sub as unknown as { current_period_end?: number }).current_period_end`. Stripe TS types moved this field; the comment explains why. This is fine for now but it's a hand-rolled shim against the SDK's type drift. If Stripe ships a typed version of the new shape, switch to it.

---

## 19. Three handlers throw 401 from a 500-style condition

**Severity: info.** Error-handling shape.

**Evidence:**

- [`auth/handler.ts:161`](../backend/src/handlers/auth/handler.ts): `if (!result.AuthenticationResult) throw createHttpError(500, 'Authentication failed')` — the "Cognito returned no AuthenticationResult on a successful InitiateAuth call" path is a Cognito-side anomaly. 500 is reasonable but a 502 would be more accurate (upstream).
- [`auth/handler.ts:236`](../backend/src/handlers/auth/handler.ts): same pattern in `refreshToken`.
- [`billing/handler.ts:106`](../backend/src/handlers/billing/handler.ts): `if (!secret) throw createHttpError(500, 'Webhook secret not configured')`. This is a configuration bug, never a user-facing one; should be a startup invariant rather than a per-request runtime throw — see Finding 5.

**Fix:** Stylistic only. Switch the two `AuthenticationResult` cases to 502, and surface the `STRIPE_WEBHOOK_SECRET` requirement as a deploy-time check (or via lazy `getStripe()`-style accessor that's checked once on cold start).

---

## 20. Lone `as any` regions live in `local-server.ts` only

**Severity: info.** Type safety.

The only `as any` / `: any` in non-test backend code is concentrated in `backend/src/local-server.ts` (~80+ occurrences), which is `@ts-nocheck`'d and explicitly dev-only. No production handler uses `: any`. `as unknown` appears 3× in services and 1× each in router/sentry — every one has a comment justifying it. Healthy.

---

## 21. Non-null assertions on `user.householdId!` repeat 43× across handlers

**Severity: info.** Type safety.

**Evidence:** `grep -c "user.householdId!"` returns 43 hits across handlers. These are safe — every handler that does this is `.use(requireHousehold())`-stacked, which already throws 403 if `householdId` is null. But each `!` is a TypeScript narrowing escape hatch.

**Fix (optional, payoff small):** Change `AuthenticatedEvent` shape to a discriminated union — or carry a `RequireHouseholdEvent` type with `householdId: string` (non-null). The middleware factory can declare it as the output type; downstream handlers see narrowed types without `!`. This is `~50 LOC` of typing in `middleware/auth.ts` and removes 43 syntactic warts. Not urgent — every `!` is provably safe today.

---

## 22. Frontend mutations rarely do optimistic updates

**Severity: info.** Frontend ergonomics.

**Evidence:** `grep onMutate frontend/src/features` returns zero hits. `setQueryData` appears once (in `NotificationSettings.tsx`). Every other mutation invalidates and refetches. For task-completion in particular, the user clicks "Complete", the server roundtrip takes ~200ms, and the row sticks around showing "due today" for that whole time before disappearing on invalidate. An optimistic update (`onMutate` → `setQueryData` removing the row + onError rolling it back) would feel instant.

**Fix:** Add optimistic updates to `completeTask` and `snoozeTask` mutations — those two are the highest-frequency. Worth doing because they're on the dashboard which is the post-login landing page.

---

## 23. Query-key inconsistency

**Severity: info.** Frontend ergonomics.

**Evidence:** Some query keys are plain strings (`['plants']`, `['tasks']`, `['chat-budget']`), some are nested (`['household', householdId, 'climate']`, `['species', 'guide', perenualSpeciesId]`), some include user-scope (`['subscription', user?.householdId]`), some don't (`['notification-prefs']` doesn't include `userId`). The latter is the bigger issue — if a user logs out and another logs in on the same device, react-query caches across users will collide unless explicitly invalidated.

**Fix:** Standardise. A `queryKeys.ts` file with `queryKeys.plants.list(householdId)`, `queryKeys.tasks.upcoming(householdId)`, etc. is the standard tanstack-query pattern and removes the "I forgot the userId in the key" foot-gun. Worth doing before adding any more queries.

---

## 24. `manualChunks` is hand-rolled — won't auto-include new vendor

**Severity: info.** Build health.

**Evidence:** [`frontend/vite.config.ts:80-86`](../frontend/vite.config.ts) lists three named manual chunks (`vendor`, `query`, `ui`). Anything else (axios, sentry, zod, zustand, i18next, etc.) goes into the per-page chunks. `size-limit` in package.json caps "All JS combined (gzipped)" at 230 kB which is a fine guardrail, but the chunking strategy will get worse over time as new vendor deps land in feature chunks.

**Fix:** Either (a) use Rollup's `manualChunks: 'auto'` mode + a function that lumps `node_modules/*` into `vendor`, or (b) leave it but add `@sentry/react`, `axios`, `i18next` to the `ui`/`vendor` map. The current setup will fragment vendor JS across feature chunks once a few more deps land.

---

## 25. PWA caches images aggressively (30 days) but doesn't include skipWaiting on auth-flow change

**Severity: info.** Bundle / PWA.

`workbox.skipWaiting + clientsClaim` is on ([`vite.config.ts:51-52`](../frontend/vite.config.ts)) — good — but the cache rule on `/\.(?:png|jpg|jpeg|svg|webp)$/i` is CacheFirst with `maxEntries: 100, maxAgeSeconds: 30 days`. User-uploaded plant photos (CloudFront/S3) live forever in that cache. If a plant photo URL ever gets reused for a different photo (impossible today — we mint per-upload UUIDs), this would be a confusion source. Today it's fine; flagging for future me.

---

# Fix order

| When          | Item                                                                                                                           | Severity | Effort |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| **Now**       | 1. Wire or remove `POST /plants/identify`                                                                                      | high     | S      |
| **Now**       | 2. Wire or remove `POST /notifications/run-reminders`                                                                          | high     | S      |
| **Now**       | 3. Fix drift-guard regex to catch JSDoc route comments                                                                         | medium   | S      |
| **Now**       | 4. Wire Sentry `instrument()` into `createHandler` (or remove the dep)                                                         | medium   | S      |
| **Now**       | 5. Declare Stripe/SES/VAPID/Sentry env vars in Terraform Lambda env                                                            | medium   | M      |
| **This week** | 6. Update `chat/handler.ts` JSDoc + add chat/identify/run-reminders to `docs/api-spec.yaml`                                    | low      | S      |
| **This week** | 7. Extract `requirePathParam` helper, replace 21 hand-rolled checks                                                            | low      | S      |
| **This week** | 8. Extract `requireHouseholdAccess` middleware for households handler                                                          | low      | S      |
| **This week** | 9. Replace manual JSON.parse handlers with `validateBody(...)`                                                                 | low      | S      |
| **This week** | 10. Wire `onError` on dashboard mutations (or standardise with `useStandardMutation`)                                          | low      | M      |
| **This week** | 13. Add `NODE_OPTIONS=--enable-source-maps` to Lambda env                                                                      | low      | S      |
| **This week** | 11. Delete dead schemas, `errorResponse`, `validatePathParams`/`validateQueryParams`, `updatePlantImage`, `evaluatePestAlerts` | low      | S      |
| **This week** | 12. Rename `getDailyCompletionCounts` → `getDailyAnalytics`; consolidate `MAX_QUERY_LIMIT`                                     | low      | S      |
| **This week** | 15. Fix `services/api.ts` doc comment (`accessToken` → `idToken`)                                                              | info     | S      |
| **This week** | 22. Add optimistic updates to `completeTask` + `snoozeTask`                                                                    | info     | S      |
| **Monitor**   | 14. Audit AWS SDK externals when chat handler bundle size becomes a problem                                                    | low      | M      |
| **Monitor**   | 16. Memoize `getUserName` in warm container                                                                                    | info     | S      |
| **Monitor**   | 18. Replace Stripe `as unknown` cast when SDK types catch up                                                                   | info     | S      |
| **Monitor**   | 19. Tighten error-status conventions (502 vs 500 on Cognito anomalies)                                                         | info     | S      |
| **Monitor**   | 21. `AuthenticatedEvent` discriminated union to eliminate `householdId!`                                                       | info     | M      |
| **Monitor**   | 23. Centralise query keys in `frontend/src/services/queryKeys.ts`                                                              | info     | M      |
| **Monitor**   | 24. Revisit Vite `manualChunks` once more deps land                                                                            | info     | S      |
| **Monitor**   | 25. Per-photo cache lifetime once we have a real eviction problem                                                              | info     | S      |

S = under an hour; M = under a day.

## Notes

- `tsc --noEmit` is green on both packages.
- `npm audit` / `npm outdated` could not be run — sandbox refuses network. Run locally if you want a vulnerability snapshot.
- All findings here are non-security per the brief. The separate OWASP review at `docs/security-review-2026-05-31.md` is unaffected.
