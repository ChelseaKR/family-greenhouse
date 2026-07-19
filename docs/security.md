# Security

> Last verified: 2026-07-14 · Recheck: every release (see "Re-running the audit")

This is a working audit against the OWASP Top 10 (2021 edition). Each category lists what's mitigated in code today, what's deferred to infrastructure (with a pointer to `production-checklist.md`), and what's an open gap. Re-run the audit before every release.

## A01:2021 — Broken Access Control

**Mitigated in code.**

- Every authenticated route runs through `authMiddleware` which projects Cognito claims onto `event.user`. Guard middlewares (`requireHousehold`, `requireAdmin`) layer on top.
- All resource handlers scope queries to `event.user.householdId`. Cross-household reads are not possible without forging a JWT (the Cognito authorizer rejects forged tokens at the gateway).
- The household activity feed and member-role endpoints both verify the path's `householdId` matches the caller's claim before any DB read.
- Plan caps (`createPlant`, `joinHousehold`) enforce server-side — the frontend's plan check is UX, not security.

**Tested**: `tests/integration/local-server.test.ts` has a `cross-household isolation` describe block that asserts a different household's user gets an empty list / 403 / 404 across plants, tasks, activity, and household reads.

## A02:2021 — Cryptographic Failures

**Mitigated.**

- Signup and password-change requests pass through application validation and
  are transmitted to Cognito, but the app never persists or logs passwords.
  Cognito is the credential store.
- Access + refresh tokens are JWT-signed by Cognito with the rotating user-pool RS256 key; signature verification is done by API Gateway, not by us.
- All traffic is HTTPS-only in production via CloudFront. The `is-on-https` Lighthouse audit is disabled only for the local `vite preview` server.
- TLS-aware S3 bucket policy denies `aws:SecureTransport: false` (set up in Terraform; verify the actual bucket policy in `infrastructure/modules/frontend`).

**Open**: secrets management for Stripe + Plant.id keys + VAPID private key. Currently env vars; should move to AWS Secrets Manager once the deploy is real (tracked in `production-checklist.md`).

## A03:2021 — Injection

**Mitigated.**

- All DynamoDB writes go through `@aws-sdk/lib-dynamodb` `DocumentClient`, which marshals values rather than building expression strings — no raw concatenation.
- All request bodies pass through Zod schemas before reaching service code. Untyped fields are rejected at the validation middleware.
- We don't use SQL, shell out to subprocesses, or `eval`/`Function` anywhere.
- The Plant.id integration forwards a base64-encoded image; the body-size guard caps it at 256 KB before any upstream call.

**Verified by**: a per-handler unit test mocks the DDB client and asserts on the parameters passed to each command.

## A04:2021 — Insecure Design

**Partially mitigated.**

- **Rate limiting**: app-level limiter at `middleware/rateLimit.ts` (10 attempts/minute per IP per route, per warm Lambda container, scoped tightly to `/auth/*`) plus API Gateway stage throttling (100 burst / 50 requests per second). Direct Cognito `SignUp` calls do not pass through the application limiter; Cognito service throttling and Threat Protection are the identity-layer backstops.
- **Password policy**: Terraform enforces 12+ characters, mixed case, and digits. Cognito Threat Protection is `ENFORCED`, adding compromised-credential and risk-based checks; symbols are deliberately not required.
- **MFA**: optional software-token TOTP is enabled in the Cognito pool. The enrollment/settings UI remains a separately scoped product feature; SMS MFA is deliberately off.
- **Account-takeover via email change**: Cognito requires re-verification of new email addresses before they replace the existing one.
- **Registration controls**: the hosted API requires an explicit shared-status
  boolean, validates the 12-character mixed-case-and-digit policy before
  dispatch, and is independently rate-limited. Because Cognito app-client IDs
  are public, callers can invoke Cognito `SignUp` directly while pool self-signup
  is enabled. A complete pause therefore requires both
  `publicRegistrationAvailable=false` and Terraform
  `public_registration_enabled=false`; the latter is the identity-boundary
  control.

**Residual:** the pool's enforced Threat Protection and Cognito's managed
progressive lockout cover automated takeover attempts. A user-visible
security-activity surface is not built and should be revisited with real abuse
or support signal.

## A05:2021 — Security Misconfiguration

**Mitigated.**

- `requireEnv()` throws at module load if `TABLE_NAME`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, or `IMAGES_BUCKET` are unset — silent misconfig is impossible.
- CORS: `ALLOWED_ORIGIN` is required in `NODE_ENV=production`; localhost is the only fallback in dev.
- The `httpJsonBodyParser` runs with `disableContentTypeError: true` so a missing Content-Type doesn't 415 GET requests (regression from the early days, fixed and tested).
- Body size guard: 256 KiB cap before JSON parse so a hostile client can't exhaust Lambda memory.
- Public S3 bucket policy denies all anonymous access except via CloudFront OAI. Lifecycle rule cleans up unused image objects (configure in Terraform).

**Resolved**: a strict CSP now ships via `<meta http-equiv="Content-Security-Policy">` in `index.html` as defense-in-depth alongside the CloudFront response-headers policy. Directives:

- `default-src 'self'`
- `script-src 'self'` (no `unsafe-eval` or `unsafe-inline`)
- `style-src 'self' 'unsafe-inline'` (required for our inline `style=` attributes)
- `img-src 'self' data: https:` (S3 image bucket + identicons)
- `connect-src 'self' http://localhost:4000 https:` (API + Stripe)
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self' https:`

## A06:2021 — Vulnerable and Outdated Components

**Monitored.**

- `npm audit --audit-level=high` runs in CI and now **blocks** on high or critical CVEs. To unblock for an urgent merge, add the advisory to `package.json` `"overrides"` or wait for the upstream patch.
- Lockfiles (`package-lock.json`) committed and verified by `npm ci` in CI to prevent dependency confusion.
- Pre-push hook runs the full test + typecheck suite, so dependency bumps that break the build never reach `origin`.

**Resolved**: Renovate (`renovate.json`, 72h `minimumReleaseAge`) and Dependabot (`.github/dependabot.yml`, npm ×3 + actions + terraform) are both configured — proactive upgrade PRs land alongside the reactive CI gate.

## A07:2021 — Identification and Authentication Failures

**Mitigated.**

- Email confirmation required before login (Cognito enforces; the local-server mirrors).
- Token refresh replaces the short-lived ID/access tokens while retaining a
  valid Cognito refresh token when Cognito does not rotate it.
- The frontend axios interceptor handles a 401 once per request; if refresh itself 401s, the user is logged out silently rather than allowed to keep clicking around with stale state.
- Session validation on app load (`authStore.verifySession`) calls `/auth/me`
  with the ID token and now attempts the same refresh flow on a 401 before
  ending the session.
- Public self-registration is enabled for free accounts. The application keeps
  a fail-closed registration flag separate from the paid-activity hold, and
  deployed smoke coverage asserts Cognito&rsquo;s self-signup policy explicitly.

**Deferred product option:** WebAuthn/passkeys would be a stronger alternative
to passwords, but no account-takeover signal currently justifies adding a
second enrollment/recovery surface. Re-open on user demand or elevated auth
incidents.

## A08:2021 — Software and Data Integrity Failures

**Mitigated.**

- npm lockfiles + commitlint conventional-commits + signed Git commits (recommended for protected branches).
- CI builds run from the lockfile; production deploys are reproducible.
- DynamoDB point-in-time recovery enabled (configure in Terraform).
- Stripe webhook signature verification on every billing event — bad signatures are rejected before any DB write.

**Release gap:** SBOM/provenance publication is not configured. It remains
explicit in the standards declaration and should be closed together so an
SBOM is tied to the exact shipped artifact, not emitted as an unauthenticated
standalone file.

## A09:2021 — Security Logging and Monitoring Failures

**Mitigated.**

- `pino` structured logger with request-id, user-id, household-id keys for every Lambda invocation.
- Discrete `audit()` helper in `utils/auditLog.ts` for security-relevant events (login success/failure, household membership changes, billing changes, account deletion). Tagged with `audit: true` so they can be subscribed to a separate sink.
- Sentry init stub on both backend and frontend; production deploys flip this on by setting the DSN env var.

**Alerting as code:** `infrastructure/modules/monitoring` provisions the
CloudWatch dashboard, operational alarms, an auth-login-failure-spike alarm,
and SNS email/SMS subscriptions when endpoints are supplied. Applying and
confirming those external subscriptions remains an environment gate. A SIEM
ingest is deliberately deferred until incident volume justifies the service.

## A10:2021 — Server-Side Request Forgery

**Mitigated.**

Outbound calls are confined to fixed-endpoint adapters: Plant.id, Perenual,
OpenWeatherMap, Stripe, Bedrock, Sentry, and notification providers. Users can
control request content (for example, an identification image or weather
location) but not the destination host, so these paths cannot be redirected to
an internal address.

If we add user-supplied URLs in the future (e.g. profile-picture imports from a URL), we need to re-audit. The standard mitigations would apply: allowlist of trusted hostnames, DNS resolution check before request, no following redirects to private CIDRs.

## What I deliberately did not do

- **Disable error messages in production.** OWASP suggests a generic 500 response so attackers can't infer internals; we surface the structured `{ message }` from each handler because that's what the frontend renders to the user. The `pino` logs hold the verbose stack — splitting logs from response bodies achieves the same goal.
- **Reject all caller-supplied IDs.** We _do_ validate UUIDs at the Zod layer; what we don't do is verify "this UUID belongs to that household" at the path-parameter layer. That check happens in the handler, after we've fetched the row. Cleaner, less duplicated code; the failure mode (404 instead of 403) doesn't leak meaningful info.

## Re-running the audit

This document is reviewed and re-signed at every minor release. The checklist is small enough to be a 30-min sweep, not a quarter-long project. When we add a new feature that touches:

- Authentication → re-do A04, A07
- New external integration → re-do A10
- New form / new request payload → re-do A03

If a feature lands without one of those reviews documented in the PR description, fail review.
