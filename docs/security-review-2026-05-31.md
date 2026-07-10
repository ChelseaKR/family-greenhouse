# Family Greenhouse — OWASP Top 10 (2021) Security Review

**Date:** 2026-05-31
**Scope:** Application code at `/Users/chelsea/family-greenhouse` (backend Lambda handlers, middleware, services, frontend React app, and the dev-only `local-server.ts`). Infrastructure Terraform is referenced for context only; no `terraform plan` was run.
**Out of scope (per request):** the orphaned WAF web ACL (API Gateway v2 HTTP doesn't accept WAF), unprovisioned secrets (Stripe / VAPID / Sentry / SES), and the broad `*.amazonaws.com` / `*.amazoncognito.com` CloudFront CSP. These are tracked elsewhere.

The review covers what the code does today; it does not re-affirm what the existing [`docs/security.md`](docs/security.md) already documents unless I disagree with it. Where it does, I say so explicitly.

---

## TL;DR

Five findings rise above the noise floor:

| #   | Finding                                                                                                           | Category  | Severity     |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------- | ------------ |
| 1   | `X-Household-Id` header is honored without any membership check, then resource handlers compare it against itself | A01       | **Critical** |
| 2   | Stripe webhook re-serializes the parsed JSON body before signature verification — every webhook will 400          | A08 + A04 | **High**     |
| 3   | Auth tokens (ID + access + refresh) persisted to `localStorage`                                                   | A07       | Medium       |
| 4   | CloudFront CSP allows `script-src 'unsafe-inline'` in production while the dev `index.html` does not              | A05       | Medium       |
| 5   | `validateInvite` is unauthenticated and discloses household name from a 12-hex-char code (48 bits)                | A01       | Low          |

Code paths that are genuinely well-handled and worth keeping intact: DynamoDB DocumentClient marshalling (A03), Zod-at-the-edge validation (A03), the `bodySizeGuard` → `httpJsonBodyParser` ordering (A05), the `requireEnv` fail-fast pattern (A05), the `deletePlantImages` swallow-and-log behavior (A04), the lone-admin self-deletion refusal (A04), the API-key SHA-256-at-rest pattern (A02), and the dual-token (ID + access) split that paired with the recent frontend fix (A07).

---

## A01:2021 — Broken Access Control

### Finding 1.1 — `X-Household-Id` header trusted without membership lookup — **Critical**

[backend/src/middleware/auth.ts:83-92](backend/src/middleware/auth.ts#L83) accepts the `X-Household-Id` request header and overwrites `event.user.householdId` with whatever the client sent:

```ts
const headerOverride = event.headers?.['x-household-id'] ?? event.headers?.['X-Household-Id'];
if (typeof headerOverride === 'string' && headerOverride.length > 0) {
  user.householdId = headerOverride;
  user.householdRole = 'member'; // downgrade
}
```

The inline comment correctly notes that this middleware can't validate membership ("no DDB calls — it runs on every request") and explicitly delegates the check to "resource-level handlers". The problem: **no resource-level handler actually performs that check**. Every household-scoped handler I read uses one of two patterns:

1. **Pattern A — direct service call with `user.householdId!`.** Example: [`listPlants`](backend/src/handlers/plants/handler.ts#L27-L35), [`listTasks`](backend/src/handlers/tasks/handler.ts#L27-L53), [`getCurrentSubscription`](backend/src/handlers/billing/handler.ts#L37-L46), [`getPrefs`](backend/src/handlers/notifications/handler.ts#L52-L58), [`getClimate`](backend/src/handlers/climate/handler.ts#L24-L55), [`exportMe`](backend/src/handlers/me/handler.ts#L78-L127). These trust `user.householdId` and immediately query DynamoDB with `HOUSEHOLD#${attacker-supplied}` as the partition key.

2. **Pattern B — path-parameter equality check.** Example: [`getHousehold`](backend/src/handlers/households/handler.ts#L71-L74), [`getActivity`](backend/src/handlers/households/handler.ts#L223-L227), [`getDailyAnalytics`](backend/src/handlers/households/handler.ts#L243-L248), [`getYearInReview`](backend/src/handlers/households/handler.ts#L263-L266) — all do `if (user.householdId !== householdId) throw 403`. Because the header has already overwritten `user.householdId` to the attacker's choice, this comparison is `headerValue === pathValue`, which the attacker controls on both sides. **It validates nothing.**

#### Repro

```http
GET /households/<victim-household-uuid> HTTP/1.1
Authorization: Bearer <attacker-id-token>
X-Household-Id: <victim-household-uuid>
```

Returns the victim's household metadata and member list (names + emails). Same template works for `/plants`, `/tasks`, `/tasks/upcoming`, `/notifications/prefs`, `/households/{id}/activity`, `/households/{id}/year-in-review`, `/households/{id}/climate`, `/me/export`, `/billing/me`, etc.

#### Blast radius

- All plant data (names, locations, notes, image URLs), all task data, all completion history, household member roster (names + emails — see [`getHouseholdMembers`](backend/src/services/householdService.ts#L185-L206)).
- Billing tier of any household (`GET /billing/me`).
- Notification preferences including phone numbers.
- Climate / geolocation of any household (`GET /households/{id}/climate` returns saved lat/lon).
- Combined with [`POST /plants/{id}/image`](backend/src/handlers/plants/handler.ts#L166-L195) → presigned PUT URLs scoped to `plants/{user.householdId}/{plantId}/…`, an attacker can upload arbitrary JPEG content (including spoofed photos) to any household's plant gallery via [`confirmImageUpload`](backend/src/handlers/plants/handler.ts#L200-L247).

Write paths gated by `requireAdmin()` (the role override-downgrade to `'member'` blocks them) and explicit role checks (e.g. [`setLocation`](backend/src/handlers/climate/handler.ts#L75-L77) which checks `user.householdRole !== 'admin'`) are NOT exploitable via this vector. So a forged header gets you read + photo-upload across all households, but not arbitrary plant deletion or member kicks.

#### Remediation

The most defensible fix is a membership cache: keep one DDB point read in front of the override, cached for the lifetime of the warm container by `(userId, householdId)`:

```ts
// In authMiddleware, before applying the override:
if (typeof headerOverride === 'string' && headerOverride.length > 0) {
  const member = await householdService.getMemberByUserId(headerOverride, claims.sub);
  if (!member) throw createHttpError(403, 'Not a member of that household');
  user.householdId = headerOverride;
  user.householdRole = member.role; // also fixes the over-conservative downgrade
}
```

That converts `authMiddleware` into an async middleware, but middy supports that natively. The DDB cost is one point-read per override request — well under the latency budget. A `lru-cache` keyed by `(userId, householdId)` with a 60s TTL keeps repeat requests free.

Stopgap if you can't ship the async version this week: drop the header override entirely and have the frontend re-call `/auth/login`-style flow to mint a new ID token with the chosen household claim. That removes the attack surface at the cost of breaking the household switcher's instant-switch UX.

---

### Finding 1.2 — `validateInvite` is unauthenticated and discloses household name — **Low**

[`GET /households/invites/{inviteCode}`](backend/src/handlers/households/handler.ts#L125-L151) is `auth = none` per [infrastructure/modules/api/main.tf:291](infrastructure/modules/api/main.tf#L291) and returns the household name on any valid code.

Invite codes are generated in [`createInvite`](backend/src/services/householdService.ts#L208-L209) as `uuid().replace(/-/g, '').substring(0, 12)` — 12 hex chars, ~48 bits of effective entropy. Per-IP rate limit on the route is not applied (the route uses bare `createHandler` without `authRateLimit`). API Gateway throttling alone won't stop a determined enumerator. Brute-forcing 2^48 over the open internet is unrealistic, but a leaked DDB dump or log line containing an active code grants household-name disclosure.

**Remediation:** mint 32-hex-char codes (128 bits, no measurable UX cost) and add `rateLimit({ perWindowMs: 60_000, max: 30 })` to this handler. The household name disclosure itself is intentional ("you've been invited to The Smiths") and acceptable once codes are properly sized.

### Well-handled (A01)

- [`requireAdmin`](backend/src/middleware/auth.ts#L122-L130) reliably 403s admin-only routes even after the header override, because the override downgrades role to `'member'`. The note "Admin-only routes still call requireAdmin which will then 403" is correct — that part of the design works.
- [`refuseIfOnlyAdmin`](backend/src/handlers/me/handler.ts#L20-L30) prevents household lockout on self-deletion.
- [`updateMemberRole`](backend/src/handlers/households/handler.ts#L293-L297) refuses self-demotion of the lone admin.
- API key scopes ([`requireApiScope`](backend/src/middleware/apiKey.ts#L74-L85)) gate per-route in [`handlers/api/handler.ts`](backend/src/handlers/api/handler.ts#L48-L103).

---

## A02:2021 — Cryptographic Failures

### Finding 2.1 — `localStorage` token storage — see A07

This is conventionally classified as A07 (Authentication), but the cryptographic angle is that the persisted refresh token is a long-lived bearer credential stored in plain text. Cross-references finding 7.1.

### Finding 2.2 — API-key hash is unsalted SHA-256 — **Info / accepted**

[backend/src/services/apiKeys.ts:87-93](backend/src/services/apiKeys.ts#L87) hashes plaintext keys with bare SHA-256:

```ts
function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
function generatePlaintext(): string {
  return `fg_${randomBytes(24).toString('hex')}`;
}
```

Unsalted SHA-256 of a low-entropy password is broken. Unsalted SHA-256 of 192 bits of `crypto.randomBytes` is not — there's no rainbow table that meaningfully covers that keyspace. The choice to use SHA-256 over bcrypt/argon2 is the right one for an indexable hash (the GSI3 lookup is a single point read against `APIKEY_HASH#<hex>`). Salting would prevent the indexed lookup. Keep this as-is.

### Well-handled (A02)

- Cognito stores password verifiers; no password material ever touches our code.
- Plaintext API key returned exactly once on creation ([apiKeys.ts:81-85](backend/src/services/apiKeys.ts#L81)); subsequent reads return `last4` only ([apiKeys.ts:69-78](backend/src/services/apiKeys.ts#L69)).
- TLS termination at CloudFront; HSTS preload header set at both CloudFront ([infrastructure/modules/frontend/main.tf:316-321](infrastructure/modules/frontend/main.tf#L316)) and Lambda response level ([backend/src/middleware/securityHeaders.ts:20](backend/src/middleware/securityHeaders.ts#L20)).

---

## A03:2021 — Injection

### Well-handled

This category is genuinely well-handled. Specific evidence:

- **No SQL, no shell-out, no `eval` / `Function`.** Grepped — none.
- All DynamoDB writes go through [`@aws-sdk/lib-dynamodb` DocumentClient](backend/src/utils/dynamodb.ts#L9-L13) with `marshallOptions.removeUndefinedValues: true`. Every `UpdateCommand` I read uses parameterized `ExpressionAttributeNames` / `ExpressionAttributeValues`, e.g. [`updatePlant`](backend/src/services/plantService.ts#L131-L217) and [`updateHouseholdSubscription`](backend/src/services/billing.ts#L49-L83) — no string concatenation of user input into expressions.
- Every body-accepting handler runs Zod validation before service code via [`validateBody`](backend/src/middleware/validation.ts#L10-L43). Schemas at [backend/src/models/schemas.ts](backend/src/models/schemas.ts#L1-L153) cap string lengths and constrain numeric ranges.
- The two unvalidated body reads I found — [`confirmImageUpload`](backend/src/handlers/plants/handler.ts#L207-L213) and [`applyTemplate`](backend/src/handlers/tasks/handler.ts#L288-L294) — both narrow to a single string field and validate inline. Not ideal stylistically but not exploitable.

### Finding 3.1 — Open redirect via cached Perenual thumbnail URL — **Info**

[`GET /species/{id}/thumbnail`](backend/src/handlers/species/handler.ts#L57-L77) returns a `302 Location: <perenualUrl>` where `perenualUrl` comes from the cached Perenual API response. An attacker who compromised Perenual or its CDN could redirect users to arbitrary hosts. The session token isn't leaked (no `Authorization` follows the redirect from the browser), but it's a phishing vector.

Mitigation cost is small: validate that `url.startsWith('https://perenual.com/')` (or the documented Perenual CDN host) before emitting the `Location`. Won't ship this quarter unless Perenual's reputation changes.

---

## A04:2021 — Insecure Design

### Finding 4.1 — Stripe webhook signature verification will always fail — **High**

[backend/src/handlers/billing/handler.ts:102-120](backend/src/handlers/billing/handler.ts#L102) is the webhook handler:

```ts
export const webhook = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ...
    const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = billing.getStripe().webhooks.constructEvent(rawBody, signature, secret);
```

The docstring claims "the body parser middleware is bypassed because Stripe wants the raw body" but `createHandler` in [backend/src/middleware/handler.ts:34-51](backend/src/middleware/handler.ts#L34) unconditionally registers `httpJsonBodyParser`. Stripe sends `Content-Type: application/json; charset=utf-8`, so middy will parse `event.body` into an object before the handler runs. By the time the handler executes, `typeof event.body === 'string'` is false, and the fallback `JSON.stringify(event.body)` produces a byte sequence that does NOT match the bytes Stripe HMAC'd (different key ordering, no whitespace, different escaping). `Stripe.webhooks.constructEvent` will throw `Webhook signature verification failed` 100% of the time.

This is simultaneously:

- **A04 (Insecure Design)** — the comment says signature verification is happening; the wiring guarantees it isn't.
- **A08 (Software and Data Integrity)** — billing state transitions (`checkout.session.completed`, `customer.subscription.deleted`) would never get applied. The existing [`docs/security.md`](docs/security.md) A08 entry claims this is mitigated; it is not.

This is latent because Stripe isn't yet provisioned (per the context note). It becomes a release blocker the moment Stripe goes live.

#### Remediation

The cleanest fix is to teach `createHandler` about a "raw body" mode and skip `httpJsonBodyParser` for the webhook route — or define a separate `createRawHandler` and use it only for `webhook`:

```ts
// new helper in middleware/handler.ts
export function createRawHandler<TEvent, TResult>(handler: Handler<TEvent, TResult>) {
  return (
    middy(handler)
      .use(securityHeaders())
      .use(bodySizeGuard())
      // no httpJsonBodyParser
      .use(httpCors({ origin: resolveCorsOrigin(), credentials: true }))
      .use(loggingMiddleware())
      .use(httpErrorHandler())
  );
}
```

Then in [billing/handler.ts](backend/src/handlers/billing/handler.ts#L102) swap `createHandler` → `createRawHandler` for the webhook only. Add a regression test that feeds the handler a real Stripe webhook fixture (Stripe's CLI can dump one) and asserts the signature verifies.

### Finding 4.2 — In-memory rate limiter is per-warm-container — **Low (accepted)**

[backend/src/middleware/rateLimit.ts:22](backend/src/middleware/rateLimit.ts#L22) and the corresponding `userBuckets` map at [rateLimit.ts:64](backend/src/middleware/rateLimit.ts#L64) live in module-level `Map`s. Each warm Lambda container has its own bucket. A credential-stuffer that arrives on N concurrent Lambdas gets N × 10 attempts/minute. The code's own docstring acknowledges this; calling it out so it doesn't get forgotten.

Cognito's built-in lockout is the real backstop. Confirm `AdvancedSecurityMode` is `ENFORCED` on the user pool, which adds Cognito's own per-account brute-force detection.

### Finding 4.3 — `auth.account_deleted` audit event defined but never emitted — **Low**

[backend/src/utils/auditLog.ts:21](backend/src/utils/auditLog.ts#L21) lists `auth.account_deleted` in the `AuditEvent` union, but [`deleteMe`](backend/src/handlers/me/handler.ts#L54-L68) doesn't call `audit()`. Same for `household.created`, `household.member_added`, `household.member_removed`, `household.role_changed`, and `plant.deleted` — all defined, none emitted. The audit log is thinner than its type declaration suggests. See A09.

### Well-handled (A04)

- Defense-in-depth `bodySizeGuard` ([middleware/bodySize.ts:12-26](backend/src/middleware/bodySize.ts#L12)) caps payloads at 256 KiB BEFORE the JSON parser allocates memory.
- Plan caps enforced server-side ([`createPlant`](backend/src/handlers/plants/handler.ts#L47-L55), [`joinHousehold`](backend/src/handlers/households/handler.ts#L175-L183)) — frontend caps are UX, not security boundaries.
- 50-plant batch cap on [`applyTemplateBulk`](backend/src/handlers/tasks/handler.ts#L233) prevents fan-out abuse.
- Server-side geocoding in [`setLocation`](backend/src/handlers/climate/handler.ts#L84-L96) — clients can't inject arbitrary lat/lon, only city names.

---

## A05:2021 — Security Misconfiguration

### Finding 5.1 — CloudFront CSP allows `script-src 'unsafe-inline'` — **Medium**

The frontend [`index.html`](frontend/index.html#L60-L63) ships a strict CSP for local dev:

```
script-src 'self'
```

But the CloudFront response-headers policy at [infrastructure/modules/frontend/main.tf:328](infrastructure/modules/frontend/main.tf#L328) ships:

```
script-src 'self' 'unsafe-inline'
```

Because CloudFront stamps its CSP via `override = true` on the same header, the strict meta-tag CSP from `index.html` is effectively overruled in production (browsers union the meta and HTTP CSPs by taking the intersection, but `'unsafe-inline'` at the HTTP layer DOES expand the allowed set when no `'strict-dynamic'` or nonce is present). The dev-time strict CSP is doing security theater; production users get the weaker policy.

This is on top of the documented broad `connect-src https://*.amazonaws.com https://*.amazoncognito.com` which I'm not re-flagging per scope.

**Remediation:** drop `'unsafe-inline'` from the CloudFront CSP `script-src`. If there's a runtime script that legitimately needs it (I didn't find any in [`frontend/src/main.tsx`](frontend/src/main.tsx) or [`App.tsx`](frontend/src/App.tsx)), refactor it to a `<script src>` reference. The CSP delta should be a one-line Terraform change followed by a Lighthouse re-run.

### Finding 5.2 — CloudFront still emits legacy `X-XSS-Protection` header — **Info**

[infrastructure/modules/frontend/main.tf:322-326](infrastructure/modules/frontend/main.tf#L322) configures `xss_protection { mode_block = true; protection = true }`. Modern guidance (Mozilla, OWASP) is to set `X-XSS-Protection: 0` and rely on CSP — older browsers' XSS-Auditor has been a vector for new XSS classes. Low impact, drop the directive when convenient.

### Well-handled (A05)

- [`resolveCorsOrigin`](backend/src/middleware/handler.ts#L23-L32) throws synchronously at module load if `ALLOWED_ORIGIN` is unset in production, falling back to `localhost:3000` only in dev. No accidental wildcard CORS.
- [`requireEnv`](backend/src/utils/env.ts#L9-L14) crashes the Lambda cold start when `TABLE_NAME` / `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` / `IMAGES_BUCKET` are missing. Misconfig is impossible in prod, and tests get a sentinel value via the `NODE_ENV === 'test'` branch.
- [`securityHeaders`](backend/src/middleware/securityHeaders.ts#L19-L25) applies HSTS preload, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a locked-down API-side CSP (`default-src 'none'; frame-ancestors 'none'`). The middleware ordering note in [handler.ts:5-12](backend/src/middleware/handler.ts#L5) ("first in registration runs last via `after`/`onError`") is correct — error responses get headers too.
- S3 bucket policies require `cloudfront.amazonaws.com` principal with `aws:SourceArn` condition ([infrastructure/modules/frontend/main.tf:335-381](infrastructure/modules/frontend/main.tf#L335)). No anonymous S3 read.

---

## A06:2021 — Vulnerable and Outdated Components

### `npm audit` execution

I attempted to execute `npm audit` and `npm audit --json` per your instructions. Both invocations were denied by the harness sandbox in this environment (Bash refused `npm` with permission errors). I substituted a manual inspection of [`package-lock.json`](package-lock.json) against the GitHub Advisory Database as of 2026-05-31 and flagged what `npm audit` would surface. Re-run `npm audit` locally before launch to confirm — the harness behavior is environmental, not a finding.

### Findings from lockfile inspection

| Package            | Installed             | Advisory                                                                                      | Severity | Path                                                |
| ------------------ | --------------------- | --------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------- |
| `esbuild`          | 0.20.2 (root devDep)  | GHSA-67mh-4wv8-2f99 — dev server allows any website to send requests to it and read responses | Moderate | [package-lock.json:9530](package-lock.json#L9530)   |
| `esbuild` (nested) | 0.21.5 (under `vite`) | Same advisory                                                                                 | Moderate | [package-lock.json:18874](package-lock.json#L18874) |

That's the only advisory that surfaces against the resolved tree on a careful manual pass. Specifically:

- **`vite` 5.4.21** ([package-lock.json:18394](package-lock.json#L18394)) is current on the 5.x line; the recent CVE-2025-30208 (`server.fs.deny` bypass) is patched at 5.4.15+, and CVE-2025-32395 / 32394 are patched at 5.4.16+ — both fixed in this version.
- **`axios` 1.16.1** ([package-lock.json:7607](package-lock.json#L7607)) is post the SSRF / cookie / decoder advisories.
- **`stripe` 22.2.0** ([package-lock.json:17282](package-lock.json#L17282)) is current.
- **`cookie` 0.7.2** ([package-lock.json:8645](package-lock.json#L8645)) is past the GHSA-pxg6-pf52-xh8x boundary.
- **`tar-fs` 3.1.2** ([package-lock.json:17524](package-lock.json#L17524)) is past CVE-2024-12905.
- **`brace-expansion` 2.1.1** ([package-lock.json:7893](package-lock.json#L7893)) is past CVE-2025-5889.
- **`postcss` 8.5.15** ([package-lock.json:15219](package-lock.json#L15219)) is past CVE-2023-44270.
- **`@babel/runtime`** present, version not pinned to a vulnerable line.

#### Workspace breakdown

The lockfile is a single hoisted tree across both workspaces (`frontend` and `backend`) per the root [`package.json:6-9`](package.json#L6) `workspaces` declaration. Both copies of `esbuild` belong to the frontend tree (`vite` for the dev server, the top-level `0.20.2` is the backend bundler under [`backend/esbuild.config.js`](backend/esbuild.config.js)). Both are dev-only; neither ships to production Lambdas or CloudFront.

#### Remediation paths

- **esbuild 0.20.2 (backend bundler):** bump to `0.25.x` in [`backend/package.json:48`](backend/package.json#L48). The dev-server advisory only impacts `esbuild serve`, which we don't use, so this is a hygiene bump.
- **esbuild 0.21.5 (transitive via vite):** waits on `vite` bumping its `esbuild` dep range. Vite 6.x already does; bumping `vite` to 6.x is a frontend-side refactor (the api/plugin loader changed). Acceptable to defer.
- **No high or critical advisories detected** in the production-shipped surface. Re-run `npm audit --workspaces --include-workspace-root` outside the sandbox to confirm — if it disagrees, trust the live run.

### Process gap

[`docs/security.md`](docs/security.md#L72) claims `npm audit --audit-level=high` blocks CI. I didn't verify the workflow file; if you want me to, point me at `.github/workflows/` and I'll re-check.

---

## A07:2021 — Identification and Authentication Failures

### Finding 7.1 — Tokens persisted to `localStorage` — **Medium**

[`frontend/src/store/authStore.ts:51-170`](frontend/src/store/authStore.ts#L51) wraps the auth store in `persist` with the default `localStorage` engine. The `partialize` at [line 148-155](frontend/src/store/authStore.ts#L148) explicitly persists `idToken`, `accessToken`, and `refreshToken`. Any XSS — including a future supply-chain compromise of a transitive Vite dep — exfiltrates all three. The refresh token gives a 30-day session per the comment at [auth/handler.ts:237-240](backend/src/handlers/auth/handler.ts#L237).

The standard mitigation (httpOnly Secure cookies) has real cost in this architecture: Cognito's `InitiateAuth` returns tokens in the response body, so the backend would need to receive them and re-emit them as cookies, and the API Gateway JWT authorizer reads from `Authorization`, not `Cookie`. So it's not a quarter-of-work fix.

Mid-cost partial mitigation worth doing now:

- Move the **refresh token** to `sessionStorage` so a closed-tab attacker can't pivot from XSS to long-lived account hijack.
- Add a `logout-on-storage-event` listener so a logout in one tab clears every tab.
- Tighten the CloudFront CSP (see Finding 5.1) to actually be useful as XSS containment.

### Finding 7.2 — `verifySession` does not validate against the API on every page load — **Info**

[`authStore.ts:107-144`](frontend/src/store/authStore.ts#L107) calls `/auth/me` on rehydrate, which is correct. Worth keeping; this also catches the pre-fix-session case at [line 161-165](frontend/src/store/authStore.ts#L161) where access-token-only persisted state is force-logged-out. Good defensive code.

### Well-handled (A07)

- The recent ID-vs-access token split ([auth/handler.ts:190-196](backend/src/handlers/auth/handler.ts#L190), [auth/handler.ts:241-246](backend/src/handlers/auth/handler.ts#L241), [auth/handler.ts:340-358](backend/src/handlers/auth/handler.ts#L340)) is correctly wired. ID token goes in `Authorization` and carries `custom:household_id`; access token goes in `X-Cognito-Access-Token` for Cognito-direct calls.
- The frontend interceptor mirrors that ([api.ts:35-37](frontend/src/services/api.ts#L35)), and [authService.changePassword + updateProfile](frontend/src/services/authService.ts#L88-L107) read the access token from the store and send it via the dedicated header.
- The `onRehydrateStorage` migration at [authStore.ts:156-167](frontend/src/store/authStore.ts#L156) force-logs-out pre-fix sessions that only have an access token — clean way to retire the bad state without a flag-day.
- `forgotPassword` ([auth/handler.ts:259-283](backend/src/handlers/auth/handler.ts#L259)) returns the same generic message on success and on Cognito errors — no account enumeration via the reset flow.
- `resendCode` swallows `UserNotFoundException` ([auth/handler.ts:96-99](backend/src/handlers/auth/handler.ts#L96)) and returns the same 200 — same enumeration defense.
- `login` failures emit an audit event ([auth/handler.ts:200-208](backend/src/handlers/auth/handler.ts#L200)) — successful brute-force attempts would be visible in logs.
- `authRateLimit` (10 req/min per IP per route) gates all `/auth/*` write paths.

---

## A08:2021 — Software and Data Integrity Failures

### Finding 8.1 — Stripe webhook signature is not actually verified

Cross-reference to Finding 4.1 — this is the same bug viewed through the integrity lens. As shipped, no Stripe webhook can update the subscription state because `constructEvent` always throws. As soon as the body parser is fixed, the integrity property holds — until then, the documented "Stripe webhook signature verification on every billing event" claim in [docs/security.md:96](docs/security.md#L96) is false.

### Finding 8.2 — Activity audit logs are best-effort and silently swallow failures — **Info**

Multiple handlers emit activity rows with `.catch(() => { /* swallow */ })`:

- [plants/handler.ts:62-72](backend/src/handlers/plants/handler.ts#L62)
- [plants/handler.ts:232-242](backend/src/handlers/plants/handler.ts#L232)
- [households/handler.ts:201-211](backend/src/handlers/households/handler.ts#L201)

The trade-off is reasonable for activity-stream rows (losing one is not a security issue) but means a failure mode "DDB rejecting writes" goes unobservable until something else catches fire. Pair the swallowed catch with a `logger.warn` so the failure shows up in CloudWatch.

### Well-handled (A08)

- DDB `TransactWriteCommand` used for household creation ([householdService.ts:62-69](backend/src/services/householdService.ts#L62)) — household row + admin-member row land atomically or not at all.
- `appendPlantPhoto` ([plantService.ts:367-389](backend/src/services/plantService.ts#L367)) uses `TransactWriteCommand` to keep the timeline row and the primary `imageUrl` consistent.
- `ConditionExpression: 'attribute_exists(PK)'` on updates (e.g. [plantService.ts:195](backend/src/services/plantService.ts#L195), [householdService.ts:90](backend/src/services/householdService.ts#L90)) prevents accidental upserts on stale identifiers.
- Lockfile committed; CI runs `npm ci`; pre-push hook runs the typecheck + test suite.

---

## A09:2021 — Security Logging and Monitoring Failures

### Finding 9.1 — Audit event taxonomy is much wider than what's emitted — **Medium**

[backend/src/utils/auditLog.ts:13-27](backend/src/utils/auditLog.ts#L13) declares 13 event types. Grep shows audit calls in exactly two handler files:

- [`auth/handler.ts`](backend/src/handlers/auth/handler.ts) — login success/failure, password reset completed, profile updated (4 events).
- [`apiKeys/handler.ts`](backend/src/handlers/apiKeys/handler.ts) — repurposed `billing.subscription_changed` for API key create + revoke (slight misuse of the event type).

Never emitted: `auth.signup`, `auth.password_reset_requested`, `auth.account_deleted`, `household.created`, `household.member_added`, `household.member_removed`, `household.role_changed`, `billing.subscription_changed` (true billing changes — Stripe webhook applies them silently), `plant.deleted`, `rate_limit.tripped`.

#### Why this matters

Post-breach forensics depend on audit logs being present. A household admin removing every other member, an attacker triggering plant deletion, a successful password reset — none of these leave an audit trail today. The general request log via `loggingMiddleware` ([backend/src/middleware/logging.ts:39-46](backend/src/middleware/logging.ts#L39)) captures the request line but not the action's intent or before/after state.

#### Remediation

Add `audit(...)` calls at the natural sites:

- [`deleteMe`](backend/src/handlers/me/handler.ts#L54) → `auth.account_deleted`
- [`createHousehold`](backend/src/handlers/households/handler.ts#L33) → `household.created`
- [`joinHousehold`](backend/src/handlers/households/handler.ts#L154) → `household.member_added`
- [`removeMember`](backend/src/handlers/households/handler.ts#L320) → `household.member_removed`
- [`updateMemberRole`](backend/src/handlers/households/handler.ts#L280) → `household.role_changed`
- [`applyStripeEvent`](backend/src/services/billing.ts#L203) → `billing.subscription_changed`
- [`deletePlant`](backend/src/services/plantService.ts#L219) → `plant.deleted` (or do it at the handler so we get the actor)
- `rateLimit` middleware throw → `rate_limit.tripped`

### Finding 9.2 — Sentry not configured in production yet — **Info (accepted, tracked elsewhere)**

[backend/src/utils/sentry.ts:11-22](backend/src/utils/sentry.ts#L11) early-returns when `SENTRY_DSN` is unset, which the context note flags as not-yet-provisioned. Not re-flagging.

### Well-handled (A09)

- `pino` child loggers carry `requestId`, `userId`, `householdId`, and `traceId` ([middleware/logging.ts:28-33](backend/src/middleware/logging.ts#L28)) — every log line is greppable by user.
- X-Ray trace id extraction from `_X_AMZN_TRACE_ID` ([utils/logger.ts:45-50](backend/src/utils/logger.ts#L45)) lets CloudWatch → X-Ray pivot work.
- `loggingMiddleware` logs both `request` and `response` lines per invocation, plus `handler_error` on throw.

---

## A10:2021 — Server-Side Request Forgery

### Well-handled

Outbound HTTP from the backend is limited to three call sites, all with hard-coded base URLs and no user-supplied URL component:

- [`plantIdentification.ts:55`](backend/src/services/plantIdentification.ts#L55) → `https://plant.id/api/v3/identification` (hard-coded constant at [line 29](backend/src/services/plantIdentification.ts#L29)).
- [`weather.ts:61`](backend/src/services/weather.ts#L61) → `https://api.openweathermap.org` (hard-coded at [line 18](backend/src/services/weather.ts#L18)), with user input flowing only into query parameters.
- [`perenual.ts:75`](backend/src/services/perenual.ts#L75) — same pattern.

The Plant.id body carries user-uploaded base64 image data, which is bounded by the 256 KiB body guard. The OpenWeatherMap and Perenual paths take user-supplied city names and species ids respectively, both of which become query string parameters — no URL composition vulnerability.

The `GET /species/{id}/thumbnail` 302 redirect to a Perenual URL is the closest thing to a finding (see 3.1) — an open redirect, not SSRF.

No CSRF vector either: API uses Bearer tokens, not cookies, and the CORS layer rejects unknown origins.

---

## Fix Order

| Priority                   | Finding                                                                                                                                   | Effort                                          | Owner area                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| **Must fix before launch** | 1.1 — `X-Household-Id` honored without membership check (cross-household read + photo-upload)                                             | M (1–2 days, async middleware + cache)          | backend/middleware           |
| **Must fix before launch** | 4.1 / 8.1 — Stripe webhook body parser eats raw body, signature never verifies                                                            | S (½ day, `createRawHandler` + regression test) | backend/middleware + billing |
| **Must fix before launch** | 5.1 — CloudFront CSP `script-src 'unsafe-inline'`                                                                                         | S (Terraform one-liner + Lighthouse re-run)     | infrastructure/frontend      |
| Fix this quarter           | 7.1 — Move refresh token off `localStorage` (sessionStorage + storage-event logout)                                                       | M                                               | frontend/store               |
| Fix this quarter           | 9.1 — Wire up the unused audit events (account deletion, household membership changes, billing webhook, plant deletion, rate-limit trips) | M (mechanical edits across 4 files)             | backend/handlers             |
| Fix this quarter           | 1.2 — Lengthen invite codes to 32 hex chars and rate-limit `validateInvite`                                                               | S                                               | backend/households           |
| Fix this quarter           | A06 — esbuild 0.20.2 → 0.25.x in backend; re-run `npm audit` outside the sandbox                                                          | S                                               | root/backend                 |
| Fix this quarter           | 8.2 — Replace `.catch(() => {})` swallows with `logger.warn`                                                                              | S                                               | backend/services             |
| Monitoring only            | 4.2 — Per-warm-container rate-limit weakness (Cognito advanced security is the real backstop)                                             | —                                               | runtime                      |
| Monitoring only            | 2.2 — Unsalted SHA-256 for API key lookup (192-bit random plaintext, indexable lookup)                                                    | —                                               | backend/apiKeys              |
| Monitoring only            | 3.1 — Open redirect via Perenual thumbnail (mitigated by Perenual reputation)                                                             | —                                               | backend/species              |
| Monitoring only            | 5.2 — Drop legacy `X-XSS-Protection` header                                                                                               | —                                               | infrastructure/frontend      |
| Monitoring only            | 7.2 — `verifySession` works correctly; keep regression coverage                                                                           | —                                               | frontend/store               |
| Monitoring only            | A06 — esbuild 0.21.5 nested under vite; waits on vite 6 upgrade                                                                           | —                                               | frontend                     |

End of review.
