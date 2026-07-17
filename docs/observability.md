# Production observability

The source-of-truth objectives live in [`observability/slos.yaml`](../observability/slos.yaml).
CloudWatch resources are declared in `infrastructure/modules/monitoring`; `npm run observability:check`
keeps the SLO, route wiring, release correlation, and metric dimensions from drifting.

## Signals

- `FamilyGreenhouse/API/{environment} ApplicationRequests` and `Application5xx` are derived from structured API
  Gateway access logs and exclude `GET /health`. They measure application traffic rather than the
  30-second synthetic probe.
- `ApplicationLatency` records the same health-excluded request population and pages when p95 is
  above 500 ms in two of three five-minute periods.
- Native `AWS/ApiGateway Count`, `4xx`, and `5xx` use the real HTTP API `ApiId` and catch gateway-level
  failures. Lambda errors, Lambda throttles, DynamoDB read/write throttles, DLQs, auth failures, and
  Route53 health have separate alarms.
- The browser reports sanitized error summaries plus LCP, CLS, and INP to `/telemetry/frontend`.
  Payloads contain an anonymous session UUID and normalized route, never a user id, query string,
  stack trace, email, phone, token, plant name, or household name.
- Authenticated product events go to `/telemetry/product`. Actor and household identity are read from
  the verified JWT; the body accepts only typed event names and bounded discriminator properties.
  Those events land in the API Lambda log group. Trusted `signup_completed` events land in the auth
  Lambda log group because Cognito confirmation precedes login; Stripe-confirmed events land in the
  billing Lambda log group. Select all three groups for a complete funnel query.

## Triage

1. Open the `family-greenhouse-production` CloudWatch dashboard and set the incident time range.
2. For application 5xx, use the “Application 5xx by route” panel, then inspect the matching Lambda log
   by `requestId`/`traceId`. Treat a frontend-error alarm similarly, grouping by `fingerprint` and
   `release` before attempting reproduction.
3. Check deploy history and the reported frontend/backend release SHA. Roll back using
   [`docs/deployment.md`](deployment.md) when failures line up with a release.
4. For a burn-rate alarm, confirm the health-excluded request/error series. Fast burn pages on 7.2%
   across most of an hour; slow burn pages on 3% across most of six hours.
5. After mitigation, confirm alarms return to `OK`, `/health` reports every component healthy, browser
   telemetry is ingesting, and a real authenticated read succeeds.

## User and error census

Cognito is the registered-user source of truth. The AWS CLI auto-paginates
`list-users`, so this returns a complete confirmed/enabled count rather than a
single page:

```bash
aws cognito-idp list-users \
  --user-pool-id <production-user-pool-id> \
  --query 'length(Users[?Enabled==`true` && UserStatus==`CONFIRMED`])' \
  --output text
```

For active users, select the production handler Lambda log groups in Logs
Insights and set the time range explicitly (the logs retain 30 days):

```text
fields @timestamp, userId, householdId, status
| filter msg = "response" and ispresent(userId)
| stats count(*) as requests, max(@timestamp) as lastSeen by userId
| sort lastSeen desc
```

To answer whether those users are seeing current failures, use the same time
range against API access logs for route/status counts, then pivot by
`requestId` into the Lambda logs. Do not treat historical 4xx as active errors
without checking the window and route; expected validation and plan-limit
responses are operationally different from 5xx.

Useful Logs Insights queries:

```text
fields @timestamp, routeKey, status, responseLatency, requestId
| filter routeKey != "GET /health" and status >= 500
| sort @timestamp desc
```

```text
fields @timestamp, fingerprint, route, release, message
| filter msg = "frontend_telemetry" and kind = "error"
| stats count(*) as occurrences, latest(message) as example by fingerprint, route, release
| sort occurrences desc
```

```text
fields @timestamp, productEvent, actorId, householdId, properties
| filter msg = "product_event"
| stats count(*) by productEvent, bin(1d)
```
