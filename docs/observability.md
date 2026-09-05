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
  have separate alarms. External availability is checked from outside the stack entirely — a Route 53
  health check and a GitHub Actions job, neither of which reads a metric this stack publishes. See
  "External availability checks" below.
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
  stack trace, email, phone, token, plant name, or household name. It also reports **how many
  reports it could not deliver** — a count and an age, never the lost payloads — which is what
  makes "no browser errors" distinguishable from "no browser could tell us"; see "Whether the
  error rail can report at all" below.
- Authenticated product events go to `/telemetry/product`. Actor and household identity are read from
  the verified JWT; the body accepts only typed event names and bounded discriminator properties.
  Those events land in the API Lambda log group. Trusted `signup_completed` events land in the auth
  Lambda log group because Cognito confirmation precedes login; Stripe-confirmed events land in the
  billing Lambda log group. Select all three groups for a complete funnel query.

## External availability checks

Almost every alarm in `infrastructure/modules/monitoring` uses
`treat_missing_data = "notBreaching"`; the exceptions are the handful watching
for absence itself, and each of them says so in a comment at its own
definition. `notBreaching` is right for each ordinary alarm individually — no
throttle events means not throttling — and collectively it means **"the stack
served nobody" produces no data points and therefore no alarm**. Nothing that
reads a metric this stack publishes can see a total outage. The checks that can
are all external, and there are two of them, deliberately different from each
other.

### 1. Route 53 health checks (30 seconds, into the alerts SNS topic)

Declared at the bottom of `infrastructure/modules/monitoring/main.tf`.

| Check                                   | Fetches                        | Passes only if                                              | Gate                       |
| --------------------------------------- | ------------------------------ | ----------------------------------------------------------- | -------------------------- |
| `aws_route53_health_check.site`         | `https://<site>/login`         | HTTP 200 **and** the body contains the app's `og:site_name` | `enable_site_health_check` |
| `aws_route53_health_check.api` (opt-in) | `https://<api>/<stage>/health` | HTTP 200 **and** the body contains `"status":"ok"`          | `enable_api_health_check`  |

Four properties of these matter more than the fact that they exist:

- **The path is not `/`.** `site_health_check_path` carries a `validation`
  block that refuses `/` outright. During the outage these exist to catch,
  `/` was the one route still answering 200 — a check on `/` would have
  reported a total outage as healthy. `/login` is also not prerendered, so
  fetching it exercises CloudFront's 403/404 → `/app-shell.html` rewrite,
  which is the machinery that actually failed.
- **A 200 is not enough.** `HTTPS_STR_MATCH` requires a literal string in the
  first 5120 bytes. The site check looks for the `og:site_name` meta tag
  `headToTags()` emits on the SPA shell and every prerendered page; the API
  check looks for `"status":"ok"`, which `GET /health` does **not** emit when
  its DynamoDB probe fails (it reports `degraded`). A healthy CDN serving
  someone else's 200, or a reachable-but-broken API, fails both.
- **Missing data is breaching.** `site_unreachable` and `api_unreachable` set
  `treat_missing_data = "breaching"` (as does the frontend-rail heartbeat
  alarm described below, for the same reason). Every other alarm is looking for a bad
  value among good ones, where absent data honestly means nothing bad
  happened. These two are looking for absence itself, so if Route 53 stops
  publishing `HealthCheckStatus` — the health check was deleted, the metric is
  unavailable — the alarm fires rather than sitting green. **"Could not
  check" is never reported as "checked and fine."**
- **They notify the same place as everything else.** `alarm_actions` and
  `ok_actions` both point at the alerts SNS topic, so a total outage arrives
  where every other alarm arrives, and recovery is announced too.

Detection is roughly three minutes: 90 seconds for three consecutive failed
probes to flip the aggregate, then two 60-second alarm periods.

Route 53 publishes `AWS/Route53 HealthCheckStatus` in **us-east-1 only**, and
a CloudWatch alarm can only notify an SNS topic in its own region. Both alarms
carry a `precondition` that fails the plan, with an explanation, if the stack
is ever deployed elsewhere — rather than creating an alarm that silently
cannot deliver.

### 2. GitHub Actions (`.github/workflows/uptime.yml`, 15 minutes)

| Job                             | What it fetches                                                                       | What it proves                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                        | `vars.HEALTHCHECK_URL` (the API's `GET /health`)                                      | The API and its database dependency answer.                                                                                                                                                                                   |
| `pages`                         | `/`, `/register`, `/login`, `/pricing` on `vars.SITE_URL`                             | Each route returns HTML that is **this app** — app root, module script, `og:site_name`, non-empty `<title>` — not merely a 200.                                                                                               |
| `pages` (2nd step)              | `/robots.txt` with `--expect-failure`                                                 | The page check can still fail. If the assertions ever soften to "any 200 passes", this step goes red while production is healthy.                                                                                             |
| `telemetry-delivery`            | A CORS preflight and a real `POST` to `/telemetry/frontend`, with the site's `Origin` | A browser could still **report** an error: the preflight answers with the exact origin (not `*`, which `allow_credentials = true` makes invalid), `POST` returns 204, and the response carries `access-control-allow-origin`. |
| `telemetry-delivery` (2nd step) | The same check against the site origin, with `--expect-failure`                       | The delivery check can still fail.                                                                                                                                                                                            |

`scripts/synthetic-page-check.mjs` is the page check. It has no dependencies
(global `fetch`) so the job is a checkout plus one `node` invocation.
`scripts/telemetry-delivery-check.mjs` is the delivery check, on the same
terms; see "Whether the error rail can report at all" below for what its
payload does after it arrives.

This is the **deeper** of the two layers and is not superseded by the health
checks: it parses the HTML and asserts four structural properties across four
routes, where Route 53 can only match one literal string. What it cannot do is
run often or report reliably — a 15-minute cron on GitHub's best-effort
scheduler, which GitHub disables outright on repositories with no recent
activity, reporting by workflow-failure email rather than to the alerts topic.
The health checks are the opposite trade. Both exist because neither subsumes
the other.

### Why both, and what is still not covered

The `pages` job and the site health check both exist because the `health` job
passed fourteen minutes into a total frontend outage on 2026-09-04
(issue #464): the API was healthy, every route except `/` was answering 403,
and nothing in the check ever loaded a page.

Still open, and deliberately not claimed as solved here:

- **Deleting the health check deletes its alarm.** Setting
  `enable_site_health_check = false` removes the probe and the alarm together,
  so there is no runtime signal left to go missing. `check
"something_can_see_a_total_outage"` in the monitoring module warns on every
  plan when an environment has alarms but no site health check, and
  `npm run observability:check` fails if the resources leave the repo — but
  neither can page you about a change already applied.
- **A partial outage below the probe.** One broken route, one broken API
  endpoint, or a failure that only reproduces for signed-in users is invisible
  to both layers; they check four public routes and one health endpoint.

## Whether the error rail can report at all

The two checks above watch the site and the API. This watches the **reporting
path**, which is a different thing and was the other half of issue #464,
closed by #576.

`reportFrontendError` posts every browser error to `POST /telemetry/frontend`
— the API it also exists to report failures of. The old sender was
`void fetch(...).catch(() => {})`: it discarded the rejection and never read
the resolved response, so an unreachable API, a CORS block, a renamed route, a
drifted schema and a rate-limited 429 were all indistinguishable from a
delivered report. `FrontendErrors == 0` therefore had two meanings — "no
browser errors" and "no browser could tell us" — and nothing anywhere could
tell them apart.

Three signals now separate them.

| Metric (`FamilyGreenhouse/Frontend/{env}`) | Source                                                                 | Alarm                  | `treat_missing_data` |
| ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------- | -------------------- |
| `FrontendErrors`                           | Browser error reports that arrived                                     | > 2 in 5 min           | `notBreaching`       |
| `FrontendReportsUndelivered`               | One point per browser **session** that reports it lost earlier reports | > 2 in 5 min           | `notBreaching`       |
| `FrontendTelemetryProbe`                   | The synthetic delivery check, every 15 min                             | **< 1 over two hours** | **`breaching`**      |

**The browser keeps the count.** A failed send increments a counter in
`localStorage` (a count and a first-failure timestamp — never a payload, never
anything a report would have carried), and the next successful delivery hands
it over as a `kind: "delivery"` report. `localStorage` rather than
`sessionStorage` because an app broken enough to lose its telemetry is one the
visitor closed. Nothing is stored under Do Not Track. This is a **late**
signal by construction — a browser cannot deliver news of an outage during the
outage — but it is the difference between an outage that leaves a trace and
one that leaves nothing.

**Errors are hooked before the app boots.** `initFrontendTelemetry()` used to
be called at `main.tsx:26`, after every import's body had already run: ES
modules evaluate dependencies before the importing module, so React, the whole
`./App` route tree, `./i18n` and both Zustand stores were all evaluated with no
handler installed, and a top-level throw in any of them was reported by
nothing. `frontend/src/telemetryBoot.ts` is now the **first** import in
`main.tsx` and `npm run observability:check` asserts that it stays first. What
this still does not cover is an entry chunk that never loads at all; that is
the site health check's job.

**Only the synthetic probe can be alarmed on for silence.**
`treat_missing_data = "breaching"` is honest only for a metric with a floor.
`FrontendErrors` has no floor and never will — this product can genuinely go an
hour with no visitors — so an alarm that paged on a quiet window would be
trained away within a month, which is why this could not be fixed by editing
one attribute. The delivery probe's cadence does not depend on anyone visiting,
so **its** absence means something: the API is unreachable, CORS on
`/telemetry/frontend` is broken, the route moved, the schema drifted, the metric
filter changed shape, or the uptime workflow stopped running. All of those mean
the same operational thing — the error rail is not trustworthy right now — and
a failure is reported twice: a red workflow immediately, and the alerts SNS
topic within about two hours.

Not covered, stated because an overstating observability doc is what produced
#464 in the first place:

- **No real-time signal from a browser that cannot reach us.** The count
  arrives when delivery works again, which may be after the visitor has gone.
  A collector on a different origin (Sentry with a DSN is the obvious one)
  would report during the outage; adopting one is a decision about a third-party
  dependency and about the sanitized-payload posture below, not a monitoring
  change, and is deliberately not made here.
- **The heartbeat depends on GitHub Actions.** Two hours of missed runs pages
  even if production is fine. The 3600-second period with two evaluation
  periods tolerates roughly seven consecutive missed 15-minute runs; an
  EventBridge canary inside AWS would remove the dependency at the cost of
  another Lambda.
- **The endpoint is public and rate-limited, so these fields are hints, not
  attestations.** A forged body can add a point to either delivery metric;
  `undelivered` is capped at 9999 and `ageMinutes` at 14 days so the skew is
  bounded. This is the same trust model `error` and `vital` have always had.
- **`MAX_ERRORS_PER_SESSION` still caps reports at 10 per session.** That is a
  deliberate suppression, not a delivery failure, and it is not counted as one.

## Where alarms are created

The title of this page is deliberate: alarms and the dashboard are a
**production** capability. `enable_monitoring_alarms` and
`enable_monitoring_dashboard` (root variables, both defaulting to `true`) gate
every `aws_cloudwatch_metric_alarm` and the `aws_cloudwatch_dashboard` in
`infrastructure/modules/monitoring`. Production sets neither and therefore keeps
every alarm and its dashboard; `environments/staging/terraform.tfvars` sets both
`false`.

The live alarm count is deliberately not written here. It was, as "28", and
this change would have made it wrong — the same hand-maintained-figure defect
`check-docs-testing.mjs` and `check-doc-figures.mjs` were each written to
retire. `npm run observability:check` refuses to let a count back into this
section; `grep -c 'resource "aws_cloudwatch_metric_alarm"'
infrastructure/modules/monitoring/main.tf` is the count of alarm _declarations_
(several expand over `for_each`, so it is a floor, not the number AWS bills).

Three blind spots were closed on 2026-09-04, at roughly $0.80/month:

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
