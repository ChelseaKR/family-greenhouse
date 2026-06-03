# Production checklist

Items below need provisioning in AWS / external services and can't be expressed
purely in code. Each one references where it would plug in once the
account/secret exists. Treat this list as the gating set for marking the
backend "production live" rather than "production-ready in code".

## AWS account and infrastructure

- [ ] **DynamoDB table `FamilyGreenhouse`** — keys `PK` (S), `SK` (S), with
      GSI1 (`GSI1PK`, `GSI1SK`) for activity feeds and assignee queries, and
      GSI2 (`GSI2PK`, `GSI2SK`) for assignee-scoped task lookups. TTL attribute
      `ttl` (used by `householdService.createInvite` for invite expiry). PITR
      on. See `infrastructure/modules/database`.
- [ ] **Cognito user pool + client** — custom attributes `custom:household_id`
      and `custom:household_role` declared as mutable strings. SES verified
      email identity for confirmation messages. Pool ID and Client ID exposed
      to Lambdas as `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID`.
- [ ] **S3 bucket** — `IMAGES_BUCKET`, with public-read on the `plants/`
      prefix or a CloudFront signed-URL setup. CORS allowing `PUT` from the
      frontend domain.
- [ ] **API Gateway** — REST API mapped onto the handlers in
      `backend/src/handlers/`, Cognito authorizer wired up so claims arrive on
      the request context (this is what `authMiddleware` reads).
- [ ] **CloudFront + S3 static frontend** — see `infrastructure/modules/frontend`.
      Don't forget the response-headers policy that adds the CSP described below.

## Secrets and configuration

- [ ] **Secrets Manager** — at minimum `SENTRY_DSN_BACKEND` and any third-party
      keys go here, surfaced into Lambdas as env at deploy time. Source of
      truth, not committed values.
- [ ] **Allowed origins** — set `ALLOWED_ORIGIN` to the production domain. The
      `createHandler` factory now refuses to start in `NODE_ENV=production`
      without this var (see `backend/src/middleware/handler.ts`).
- [ ] **Required env vars**: `TABLE_NAME`, `COGNITO_USER_POOL_ID`,
      `COGNITO_CLIENT_ID`, `IMAGES_BUCKET`, `ALLOWED_ORIGIN`,
      `FRONTEND_URL`. The backend uses `requireEnv()` and now fails at module
      load if any are missing.

## Observability

- [ ] **Sentry project** — `SENTRY_DSN` (backend) and `VITE_SENTRY_DSN`
      (frontend) need real values. The init stubs at
      `backend/src/utils/sentry.ts` and `frontend/src/sentry.ts` no-op without
      them, so flipping observability on is a deploy-time config change, not a
      code change.
- [ ] **AWS X-Ray** — wrap each Lambda handler with the Powertools tracer
      (`@aws-lambda-powertools/tracer`). Requires `Tracing: Active` on the
      Lambda and IAM `xray:PutTraceSegments` / `xray:PutTelemetryRecords`. This
      isn't done in code yet because tracer init needs the runtime to register
      a Lambda extension; do it as part of the Lambda layer setup.
- [ ] **CloudWatch dashboards + alarms** — error rate, p99 latency, cold-start
      count per handler. `infrastructure/modules/monitoring` is the home for
      this.
- ✅ **Log retention** — Lambda + API Gateway log groups set to 30d in
  `infrastructure/modules/api/main.tf`.

## Security

- [ ] **WAF** — attach AWS WAF managed rule sets (Common, Known Bad Inputs, and
      a per-IP rate-limit rule) to the CloudFront distribution and API
      Gateway.
- [ ] **CSP** — add this header via the CloudFront response-headers policy:
      `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://${IMAGES_BUCKET}.s3.amazonaws.com; connect-src 'self' https://${API_DOMAIN}`.
      Plus `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
      `Referrer-Policy: strict-origin-when-cross-origin`.
- [ ] **Cognito password policy** — minimum 12 chars, complexity, breach-list
      check. Configure in the user pool, not in code.
- [ ] **MFA** — opt-in TOTP. Same as above.
- [ ] **API Gateway throttling** — usage plan with a burst/rate per Cognito
      user, plus a tighter per-IP rule on `/auth/*`.
- [ ] **S3 bucket policy** — block public access except via CloudFront OAI;
      lifecycle rule deleting objects under `plants/` whose plant is gone (the
      Lambda doesn't know how to delete S3 objects yet — see "TODOs" below).

## CI/CD

- [ ] **Terraform remote state** — S3 backend with DynamoDB state-lock table.
      `backend.tf` declares the backend; the bucket and lock table need to
      exist before `terraform init`.
- [ ] **GitHub Actions secrets** — `AWS_ROLE_ARN` (use OIDC, not static keys),
      `SENTRY_AUTH_TOKEN` (for source-map upload), `STAGING_API_URL`,
      `PRODUCTION_API_URL`.
- [ ] **Per-PR preview environments** — spin up a per-branch frontend on a
      CloudFront preview stage that points at a shared dev backend. Out of
      scope for the current code; needs a Terraform workspace per PR.
- [ ] **Promote staging → production** — manual approval gate in
      `cd-production.yml`.

## Reminders / notifications

- ✅ **Reminder service + scheduler (code + IaC).** `services/reminders.ts`
  (`remindHousehold` / `remindAllHouseholds`), the EventBridge-invoked
  `handlers/reminders/handler.ts`, and the hourly `aws_cloudwatch_event_rule` + Lambda + IAM (SES/SNS) are all in the repo and `terraform validate`-clean.
  `householdService.listAllHouseholdIds` enumerates households for the scan.
- [ ] **Provision delivery (env + accounts)** — set `SES_FROM_EMAIL` (verified
      SES identity) and `WEB_PUSH_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY` on the
      Lambda env. Until then the notifier dry-run-logs instead of sending, so
      the schedule runs harmlessly. SMS stays off for beta (`SMS_NOTIFICATIONS_ENABLED`
      unset) — turning it on needs SNS sandbox exit.
- ✅ **Web Push subscribe/store** — `PushManager` subscribe + DDB storage are
  implemented (`services/pushSubscriptions.ts`, settings UI); delivery
  flips on once the VAPID keys above are set.

## TODOs that surfaced during the testing pass

- ✅ **S3 object lifecycle**: `plantService.deletePlant` now sweeps the
  deleted plant's images from S3 (`plants/{householdId}/{plantId}/` prefix,
  via `ListObjectsV2` + `DeleteObjects`). Guarded on `IMAGES_BUCKET` so it's a
  clean no-op in dev/tests, and best-effort (failures are logged, never thrown
  — the DDB rows are already gone). A bucket **lifecycle rule** is still worth
  adding as a backstop for objects orphaned by a failed sweep (see "S3 bucket
  policy" above).
- ✅ **Cognito attribute propagation**: `HouseholdOnboarding` now calls
  `/auth/refresh` immediately after creating the first household, so the very
  first `/dashboard` request carries the freshly-minted `custom:household_id`
  claim instead of eating a 403 and bouncing through the interceptor. The
  401-refresh interceptor remains the safety net if that refresh fails.
- **Bundle size budget**: add `size-limit` to `frontend/package.json` with a
  ceiling per chunk so PRs that double the bundle get flagged. Drop it in
  `ci.yml` after the first deploy gives us baseline numbers.
- ✅ **GDPR data export**: `GET /me/export` is implemented (handler +
  local-server mirror + OpenAPI entry + integration tests), returning a
  downloadable JSON document of the caller's profile, notification
  preferences, memberships, and the plants/tasks of every household they
  belong to. Surfaced in Account settings alongside the CSV convenience
  export. Together with `DELETE /me` this covers the GDPR access + erasure
  contract.

## API Gateway wiring (✅ resolved in code; AWS apply pending)

The two blockers that previously made the deployed backend non-functional are
now fixed and `terraform validate`-clean — they just need an actual
`terraform apply` (which needs an AWS account, so it can't be verified here):

1. ✅ **All 11 handler groups (+ the EventBridge `reminders` function) are
   wired.** `local.lambda_handlers` lists every group; routes are a single
   `aws_apigatewayv2_route` `for_each` over `local.routes` (one explicit route
   per endpoint, ~68 total). The per-route auth model mirrors each handler's
   middleware: JWT authorizer for protected routes; **none** for the genuinely
   public ones (pre-login `/auth/*`, `GET /billing/plans`, `POST /billing/webhook`,
   `GET /tasks/templates`, `GET /households/invites/{inviteCode}`); and **none**
   for `/api/v1/*` (API-key middleware authenticates in-handler). A wrong flag
   fails closed (401/locked), never open, because the handlers also enforce auth.
2. ✅ **Per-route dispatcher exists.** `backend/src/middleware/router.ts`
   (`createRouter`) is exported as each group's `handler`, keying on
   `event.routeKey` (with a v1 `httpMethod + resource` fallback). A drift test
   (`tests/unit/middleware/router.test.ts`) asserts every `// METHOD /path`
   comment has a dispatcher entry. The middleware was also made HTTP-API-v2
   aware (claims at `authorizer.jwt.claims`, method/path under
   `requestContext.http`).

Remaining to go live: `terraform apply` (with remote state bootstrapped per
`backend.tf`), the CD smoke step confirming routing end-to-end, and the
secret/identity provisioning below. WAF-on-API still needs the CloudFront-in-front
decision (see `modules/security`).
