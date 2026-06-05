# Runbooks

Step-by-step responses to specific production failures. Each entry: **symptom → diagnosis → fix**. When you resolve a new class of incident, add an entry here. See [`incidents.md`](incidents.md) for the overall severity/comms process.

Assumed context: single region **us-east-1**, serverless stack (API Gateway HTTP API → Lambda per handler group → DynamoDB single table), CloudWatch dashboard `family-greenhouse-production`, alerts fan out to the `family-greenhouse-alerts-production` SNS topic (email).

---

## Roll back a bad deploy

**Symptom:** errors/latency spiked right after a deploy or `v*` tag.

**Auto path:** a failing post-deploy smoke test already triggers the `rollback` job in `cd-production.yml`, which restores each Lambda's previous published version from `s3://<artifact-bucket>/lambda-versions/`. Confirm it fired (Actions run → `rollback` job).

**Manual path:** if you need to roll back without a smoke failure:

```bash
# List recent versions for a function
aws lambda list-versions-by-function --function-name family-greenhouse-<group>-production \
  --query 'Versions[-3:].[Version,LastModified]' --output table
# Restore a known-good version's code (zips are archived per published version)
aws lambda update-function-code --function-name family-greenhouse-<group>-production \
  --s3-bucket <artifact-bucket> --s3-key lambda-versions/<group>-v<N>.zip --publish
```

Then re-run `GET /health` and the smoke check. **Frontend** rollback = re-sync the previous `dist/` to the S3 bucket and invalidate CloudFront.

---

## DynamoDB throttling

**Symptom:** `DDB throttle` panel non-zero on the dashboard; 5xx or slow writes; `ProvisionedThroughputExceeded`/`ThrottlingException` in logs.

**Diagnosis:** the table is on-demand (PAY_PER_REQUEST), so sustained throttling means either a hot partition or a runaway caller. Check: which access pattern? A single household hammering one PK (`HOUSEHOLD#<id>`)? A loop in a handler?

**Fix:**

1. Identify the hot key from logs (every request logs `householdId`).
2. If it's a runaway client, rate-limiting already exists per-IP and per-user (`middleware/rateLimit.ts`) — confirm it's engaged for that route.
3. On-demand scales automatically but has a ramp; for a sudden 10x, request a service quota bump or pre-warm. Persistent hot partitions are a data-model issue — file a follow-up, don't hot-patch the schema during the incident.

---

## Stripe webhooks not applying

**Symptom:** a user paid but their plan didn't change; or subscription state looks stale.

**Diagnosis:**

1. Stripe Dashboard → Developers → Webhooks → check delivery attempts + response codes to `POST /billing/webhook`.
2. **403/400 with signature error** → `STRIPE_WEBHOOK_SECRET` mismatch between Stripe and the Lambda env. The handler uses the **raw** body for signature verification (`createRawBodyHandler`); if someone reintroduced a JSON body parser on that route, every signature fails — check `handlers/billing/handler.ts`.
3. **200 but no change** → the event may have been deduped. Webhook processing is idempotent: each `event.id` is recorded once (`STRIPE_EVENT#<id>`), and a redelivery logs `stripe_event_duplicate_skipped` and skips. That's correct behavior, not a bug — verify the _first_ delivery actually applied.

**Fix:** correct the webhook secret and **resend** the event from the Stripe Dashboard (idempotency makes resends safe). For a one-off correction, the household's `planId`/subscription fields can be patched directly on its `HOUSEHOLD#<id>` / `METADATA` item.

---

## Reminders not sending

**Symptom:** users report missing watering reminders.

**Diagnosis:** reminders run hourly via an EventBridge rule → `reminders` Lambda → SES (email) / SNS (SMS) / web push.

1. EventBridge → rule `family-greenhouse-reminders-production` → confirm it's enabled and firing.
2. `reminders` Lambda logs (CloudWatch) → did the scan run? Any errors per channel?
3. **Email silent** → SES still in sandbox, or `SES_FROM_EMAIL` unset/unverified. **SMS silent** → `SMS_NOTIFICATIONS_ENABLED` not `1`, or SNS spend limit hit. Each channel falls back to a structured log line when unconfigured — grep for it.

---

## Cost spike

**Symptom:** the monthly budget alarm emailed (80% actual or 100% forecast).

**Diagnosis:** Cost Explorer → group by service. Usual suspects: a Lambda in a retry loop (esp. `chat` → Bedrock), DynamoDB throttle-retry storm, or unexpected egress.

**Fix:** trace the runaway to a handler, fix or disable it, then confirm the dashboard normalizes. The budget is a guardrail, not a circuit breaker — it won't stop spend on its own.

---

## Lambda cold-start / latency

**Symptom:** intermittent slow first requests, `p95` panel elevated.

**Diagnosis:** cold starts are expected at low traffic. The `chat` Lambda is 512MB/90s on purpose (Bedrock tool loop); others are 256MB/30s. A _sustained_ p95 climb that isn't cold starts points at a downstream dependency (DDB, Bedrock, an external API) — check X-Ray traces (trace id is on every log line).

---

## Data restore (DynamoDB PITR)

**Symptom:** data corruption or accidental deletion needing point-in-time recovery.

> ⚠️ This is destructive and rarely rehearsed — **read fully before running**, and prefer restoring to a _new_ table over overwriting.

1. PITR is enabled on the production table. Restore to a **new** table name:
   ```bash
   aws dynamodb restore-table-to-point-in-time \
     --source-table-name FamilyGreenhouse-production \
     --target-table-name FamilyGreenhouse-restore-<date> \
     --use-latest-restorable-time   # or --restore-date-time <ISO8601>
   ```
2. Validate the restored data out-of-band before any cutover.
3. Cutover (point Lambdas at the new table via `TABLE_NAME`, or copy the needed items back) is a deliberate, reviewed step — not done mid-panic.

A real restore drill is still outstanding (see [`production-checklist.md`](production-checklist.md) / [`deferred-resilience.md`](deferred-resilience.md)); run one in staging before you ever need it for real.
