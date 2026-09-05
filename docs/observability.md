# Production observability

The source-of-truth objectives live in [`observability/slos.yaml`](../observability/slos.yaml).
CloudWatch resources are declared in `infrastructure/modules/monitoring`; `npm run observability:check`
keeps the SLO, route wiring, release correlation, and metric dimensions from drifting.

## Signals

- `FamilyGreenhouse/API/{environment} ApplicationRequests` and `Application5xx` are derived from structured API
  Gateway access logs and exclude `GET /health`. They measure application traffic rather than the
  external uptime probe (see "External availability checks" below).
- `ApplicationLatency` records the same health-excluded request population and pages when p95 is
  above 500 ms in two of three five-minute periods.
- Native `AWS/ApiGateway Count`, `4xx`, and `5xx` use the real HTTP API `ApiId` and catch gateway-level
  failures. Lambda errors, Lambda throttles, DynamoDB read/write throttles, DLQs, and auth failures
  have separate alarms. There is no Route53 health check — external availability is checked from
  GitHub Actions instead; see "External availability checks" below and issue #464.
- **Server-side logs are redacted at the logger.** `backend/src/utils/logger.ts` censors `email`,
  `to`, `phone`, `password`, `pin`, `token`/`refreshToken`/`accessToken`/`idToken`, `apiKey`,
  `imageBase64` and `authorization` — at the top level and one or two levels down — with
  `[redacted]`. It is a backstop against an accidental `logger.info({ ...body })`, not a licence to
  log personal data on purpose. **`actorEmail` is deliberately exempt**: the audit trail in
  `backend/src/utils/auditLog.ts` exists to answer "who did this" without a Cognito join, so the
  Lambda log groups are an in-scope store of member email addresses. The mitigation is the 30-day
  retention on every group, which means an erasure request reaches log data in 30 days rather than
  immediately — see [`compliance.md`](compliance.md).
- The browser reports sanitized error summaries plus LCP, CLS, and INP to `/telemetry/frontend`.
  Payloads contain an anonymous session UUID and normalized route, never a user id, query string,
  stack trace, email, phone, token, plant name, or household name.
- Authenticated product events go to `/telemetry/product`. Actor and household identity are read from
  the verified JWT; the body accepts only typed event names and bounded discriminator properties.
  Those events land in the API Lambda log group. Trusted `signup_completed` events land in the auth
  Lambda log group because Cognito confirmation precedes login; Stripe-confirmed events land in the
  billing Lambda log group. Select all three groups for a complete funnel query.

## External availability checks

Every alarm in `infrastructure/modules/monitoring` uses
`treat_missing_data = "notBreaching"`, so "traffic went to zero" is
indistinguishable from "everything is healthy". The only signals that can see a
total outage are external, and they live in `.github/workflows/uptime.yml`
(`*/15 * * * *`, plus `workflow_dispatch`):

| Job                | What it fetches                                           | What it proves                                                                                                                    |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `health`           | `vars.HEALTHCHECK_URL` (the API's `GET /health`)          | The API and its database dependency answer.                                                                                       |
| `pages`            | `/`, `/register`, `/login`, `/pricing` on `vars.SITE_URL` | Each route returns HTML that is **this app** — app root, module script, `og:site_name`, non-empty `<title>` — not merely a 200.   |
| `pages` (2nd step) | `/robots.txt` with `--expect-failure`                     | The page check can still fail. If the assertions ever soften to "any 200 passes", this step goes red while production is healthy. |

`scripts/synthetic-page-check.mjs` is the page check. It has no dependencies
(global `fetch`) so the job is a checkout plus one `node` invocation.

The `pages` job exists because the `health` job passed fourteen minutes into a
total frontend outage on 2026-09-04 (issue #464): the API was healthy and every
route except `/` was answering 403, and nothing in the check ever loaded a page.

Two gaps in this arrangement are known and tracked in issue #464, not closed
here: the cadence is fifteen minutes rather than the 30 seconds this document
once claimed, and a failure arrives as a workflow-failure email rather than
through the alerts SNS topic every CloudWatch alarm routes to. There is no
`aws_route53_health_check` in `infrastructure/`; choosing between adding one and
routing these jobs into SNS is an open owner decision.

## Where alarms are created

The title of this page is deliberate: alarms and the dashboard are a
**production** capability. `enable_monitoring_alarms` and
`enable_monitoring_dashboard` (root variables, both defaulting to `true`) gate
every `aws_cloudwatch_metric_alarm` and the `aws_cloudwatch_dashboard` in
`infrastructure/modules/monitoring`. Production sets neither and therefore keeps
all 28 alarms and its dashboard; `environments/staging/terraform.tfvars` sets
both `false`.

Eight of those 28 were added on 2026-09-04 for three blind spots, at roughly
$0.80/month:

- **Scheduled-run failures** (`*-reminders-run-failed`, `*-digests-run-failed`).
  The reminder and digest fan-outs catch each per-household error, count it and
  log at WARN, then return normally — so a run in which EVERY household failed
  produced no Lambda `Errors` point, nothing in the DLQ and no signal at all.
  It was byte-identical, from the outside, to a quiet week. Metric filters over
  the `reminders.run_complete` / `digest.run_complete` / `recap.run_complete`
  lines publish `failed` and `sent`; the alarms fire on a non-zero `failed`.
  `sent` is published but not alarmed on: a "sent must not be zero" alarm needs
  a volume floor the product does not have data for yet, and one that fires on
  a genuinely quiet week gets trained away within a month.
- **Two more functions on the per-function `Errors` alarm** (`digests`,
  `emailEvents`), and a threshold that can actually be reached. The old flat
  `> 5 Sum over 2 consecutive 5-minute periods` was **unreachable for any
  async function**: EventBridge retries a target at most 4 times, so a totally
  broken run emits at most 5 `Errors` data points, and 5 is not > 5 — let alone
  in each of two consecutive periods. The alarm on `reminders`, kept
  per-function precisely because "an async failure surfaces nowhere else",
  could not fire for the failure it existed for. Scheduled functions now alarm
  at `> 0` over one period; `chat` keeps the volume threshold that suits a
  user-facing path. `Duration` alarms stay on `reminders` + `chat` only — a
  weekly digest legitimately runs long.
- **Scheduled-run truncation** (`*-reminders-run-truncated`,
  `*-digests-run-truncated`). Read this one next to the first bullet, because
  it closes the hole that bullet's fix would otherwise have opened. The
  fan-outs used to walk every household in a serial loop with no clock in it;
  past a few hundred households a run went past its 30-second timeout and was
  killed wherever it happened to be, and EventBridge's retry restarted it at
  household #1 and died in the same place — so the tail of the list was not
  delayed, it was unreachable. That failure at least produced a Lambda
  `Errors` point. `services/scheduledFanOut.ts` now stops cleanly on a
  deadline and resumes next run from where it stopped, which fixes the tail —
  and makes the run RETURN SUCCESSFULLY, deleting the only signal the old
  shape had. So the run summaries carry `truncated` and these alarms watch it.
  It is deliberately not folded into `failed`: nobody was mailed wrongly and
  nothing was lost, so this is a capacity signal (raise the timeout, or land
  the GSI household directory that removes the full-table scan), not a
  correctness one. Reminders alarm only on two consecutive truncated hours,
  because one hour is caught up by the next; digests alarm on one, because the
  four Monday runs are the whole budget for that week and there is no next run
  to catch up in.
- **SES reputation** (`*-ses-bounce-rate`, `*-ses-complaint-rate`).
  `reputation_metrics_enabled` has been on since the email module shipped and
  nothing watched what it published. AWS reviews an identity at a 5% bounce
  rate and can pause sending; because transactional and non-transactional mail
  share the domain, the first symptom is that nobody can complete a password
  reset. Thresholds are 3% and 0.05%, both under AWS's, sustained over three
  hourly datapoints so one bounce in a quiet week cannot page.

Staging is off because its alerts SNS topic had no subscribers — `alert_email`
is empty there, so 18 alarms plus a dashboard billed roughly $5.60/month to
notify nobody. An alarm whose destination is empty is cost without coverage, so
the module carries a `check "alarms_have_a_notification_destination"` block that
warns on every plan when `enable_alarms` is true and the topic has neither an
email nor an SMS subscription. Re-enable staging monitoring by setting
`alert_email` (or `alert_sms_number`) first, then flipping the two flags back to
`true`; doing it in the other order recreates the same silent bill and the check
will say so.

Metric filters, the SNS topic, the budget, and Cost Anomaly Detection are not
gated — they are free or near-free and several are the data source the alarms
would read on the way back up.

## Triage

1. Open the `family-greenhouse-production` CloudWatch dashboard and set the incident time range.
2. For application 5xx, use the “Application 5xx by route” panel, then inspect the matching Lambda log
   by `requestId`/`traceId`. Treat a frontend-error alarm similarly, grouping by `fingerprint` and
   `release` before attempting reproduction.
3. Check deploy history and the reported frontend/backend release SHA. Roll back using
   [`docs/deployment.md`](deployment.md) when failures line up with a release.
4. For a burn-rate alarm, confirm the health-excluded request/error series. Fast burn pages on 7.2%
   across most of an hour; slow burn pages on 3% across most of six hours.
5. After mitigation, confirm alarms return to `OK`, `/health` reports `status: ok` with its
   `database` component `ok` (`auth` and `mail` are never probed and always report `unknown` —
   a green `/health` is not evidence that Cognito or SES recovered; check those directly), browser
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

The RAG grounding guard emits one of three events per checked answer, one per
verdict (see [ADR 0009](adr/0009-three-state-grounding-verdict.md)). The event
name carries the verdict so a query for "answers the guard verified" cannot
sweep up answers it merely didn't recognize:

| event                       | meaning                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `chat_grounding_checked`    | verified: ≥1 quantitative or pet-safety claim checked, all traced to a retrieved span/verdict |
| `chat_grounding_unverified` | the guard checked nothing it can vouch for; the answer was still returned                     |
| `chat_grounding_blocked`    | a recognized claim was unsupported; the answer was replaced                                   |

Every event carries `claimsChecked` (quantitative) and `safetyClaimsChecked`
(categorical pet-safety claims, [ADR 0011](adr/0011-categorical-pet-safety-claims-block.md)).
`chat_grounding_blocked` additionally carries `blockedOn` (`safety` |
`quantitative`) and `ungroundedSafetyClaimCount`. A safety block with
`sourceCount: 0` is the model asserting a plant is safe for pets without
having called `check_pet_toxicity` at all — the primary failure mode the
tool exists to remove, and the row to watch after a model or prompt change:

```text
fields @timestamp, blockedOn, sourceCount, safetyClaimsChecked, conversationId
| filter msg = "chat_grounding_blocked" and blockedOn = "safety"
| stats count(*) as blocked by sourceCount, bin(1d)
```

```text
fields @timestamp, claimsChecked, unclassifiedNumericCount, sourceCount, conversationId
| filter msg like /^chat_grounding_/
| stats count(*) as answers by msg
| sort answers desc
```

`chat_grounding_checked` always carries `claimsChecked >= 1`; a zero there
would be a bug, not a vacuous pass. Vacuous passes are the
`chat_grounding_unverified` rows, and they are an observability signal rather
than a failure: qualitative answers legitimately contain nothing this guard is
designed to inspect. The row worth watching is
`chat_grounding_unverified` with `unclassifiedNumericCount > 0` — an answer
that carried a number no claim shape matched:

```text
fields @timestamp, unclassifiedNumericCount, sourceCount, conversationId
| filter msg = "chat_grounding_unverified" and unclassifiedNumericCount > 0
| stats count(*) as answers by bin(1d)
```

A sustained volume there is the evidence for deciding whether that case should
block (deliberately left open in ADR 0009). Investigate alongside request mix
and manual review; the current offline evaluation suite cannot explain it, and
answer or source text must never be added to this log.

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
