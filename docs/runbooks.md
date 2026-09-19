# Runbooks

Step-by-step responses to specific production failures. Each entry: **symptom → diagnosis → fix**. When you resolve a new class of incident, add an entry here. See [`incidents.md`](incidents.md) for the overall severity/comms process.

Assumed context: single region **us-east-1**, serverless stack (API Gateway HTTP API → Lambda per handler group → DynamoDB single table), CloudWatch dashboard `family-greenhouse-production`, alerts fan out to the `family-greenhouse-alerts-production` SNS topic (email).

---

## Roll back a bad deploy

**Symptom:** errors/latency spiked right after a deploy or `v*` tag.

**Auto path:** a failed backend/frontend deploy or post-deploy smoke test triggers
the `rollback` job in `cd-production.yml`. It restores the exact pre-deploy
Cognito self-signup policy with a targeted Terraform apply, restores the
pre-deploy frontend snapshot and
invalidates CloudFront, then restores each Lambda's previous published version
from `s3://<artifact-bucket>/lambda-versions/`. Confirm the whole job completed;
a red rollback job means production may be only partially restored.

**Manual path:** if you need to roll back without a smoke failure:

```bash
# List recent versions for a function
aws lambda list-versions-by-function --function-name family-greenhouse-<group>-production \
  --query 'Versions[-3:].[Version,LastModified]' --output table
# Restore a known-good version's code (zips are archived per published version)
aws lambda update-function-code --function-name family-greenhouse-<group>-production \
  --s3-bucket <artifact-bucket> --s3-key lambda-versions/<group>-v<N>.zip --publish
```

Then re-run `GET /health` and the smoke check. If the release changed public
registration, restore the known pre-deploy value with Terraform's
`public_registration_enabled=<true|false>` override; do not issue a partial
`update-user-pool` command because omitted Cognito settings can reset to service
defaults. **Frontend** rollback = re-sync the previous `dist/` to the S3 bucket
and wait for CloudFront invalidation before restoring the previous Lambda code.

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

## Issue a refund

**Symptom:** a customer's charge needs to be refunded — a duplicate, a
mistaken renewal, a case decided by hand from the support mailbox. See
`docs/billing.md` § Refunds for the full policy (#426): there is no self-serve
path and no stated refund window; every refund is a case-by-case decision the
operator makes.

**Fix**, from the repo root, with `STRIPE_SECRET_KEY` in the environment:

```bash
# dry run first — always safe, issues nothing
node scripts/issue-refund.mjs \
  --payment-intent pi_... --reason "customer says renewed after cancelling" \
  --issued-by "Chelsea"

# then, once you're satisfied, add --apply
node scripts/issue-refund.mjs \
  --payment-intent pi_... --reason "customer says renewed after cancelling" \
  --issued-by "Chelsea" --apply
```

Use `--charge ch_...` instead of `--payment-intent` if that's what you have,
and add `--amount 4.99` for a partial refund (omit it for the full amount). A
successful `--apply` appends to `docs/refund-log.json` — commit that file so
the refund has a durable record. If a pack of identification credits was
attached to the refunded charge, nothing un-grants them automatically; check
`docs/billing.md` § Refunds → Reconciling.

---

## Send a price-change notice

**Symptom:** a plan's price is about to change and existing subscribers need
the 14 days' notice `legal.terms.priceChanges.body` promises (#710). See
`docs/billing.md` § _Price changes_ for the full contract.

**Fix**, from `backend/`, with AWS credentials for the target environment
(`TABLE_NAME` + `SES_FROM_EMAIL`):

```bash
# dry run first — prints how many households would be notified, sends nothing
npm run notify:price-change --workspace backend -- \
  --id garden-monthly-2026-11-01 --plan garden --interval month \
  --old 4.99 --new 5.99 --effective 2026-11-01 \
  --summary "Garden monthly is moving from $4.99 to $5.99; see ADR NNNN."

# then, once you're satisfied, add --confirm
npm run notify:price-change --workspace backend -- \
  --id garden-monthly-2026-11-01 --plan garden --interval month \
  --old 4.99 --new 5.99 --effective 2026-11-01 \
  --summary "Garden monthly is moving from $4.99 to $5.99; see ADR NNNN." \
  --confirm
```

`--effective` must be at least 14 days out or the script refuses to send. A
successful `--confirm` run also appends to `docs/price-change-notices.json` —
commit that alongside the run. Re-running the same `--id` is safe: recipients
already mailed are skipped, not mailed twice.

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

**Symptom:** `family-greenhouse-latency-fast-burn-production` or
`family-greenhouse-latency-slow-burn-production` in ALARM; intermittent slow first requests, `p95`
panel elevated.

**Diagnosis:** cold starts are expected at low traffic, and the burn-rate alarms are calibrated so
that the _expected_ rate of them does not page — fast fires when >72% of requests exceed 500 ms
across most of an hour, slow when >30% do across most of six hours. Replayed over the 28 days to
2026-09-13, fast fired 0 times and slow fired once. So either of these in ALARM means the share of
slow requests has moved, not that a cold start happened. The `chat` Lambda is 512MB/90s on purpose (Bedrock tool loop); others are 256MB/30s. A _sustained_ p95 climb that isn't cold starts points at a downstream dependency (DDB, Bedrock, an external API) — check X-Ray traces (trace id is on every log line).

---

## Data restore (DynamoDB PITR)

**Symptom:** data corruption or accidental deletion needing point-in-time recovery.

> ✅ **Drilled 2026-06-09** against the live table (restore to a throwaway table, validated, deleted). PITR is enabled; the procedure below works.
> **Observed RTO ≈ 3.5 min** (35-item table → ACTIVE; larger tables take longer — minutes, not seconds, even when small). **RPO ≈ 5 min** (DynamoDB PITR's restore granularity — you can lose up to ~5 min of writes).
> ⚠️ Restoring is non-destructive _if_ you restore to a NEW table (below). Never restore over the live table.

1. Confirm PITR + the restorable window:
   ```bash
   aws dynamodb describe-continuous-backups --table-name family-greenhouse-production \
     --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.{status:PointInTimeRecoveryStatus,earliest:EarliestRestorableDateTime,latest:LatestRestorableDateTime}'
   ```
2. Restore to a **new** table (note `--billing-mode-override` so the restore inherits on-demand billing, not provisioned):
   ```bash
   aws dynamodb restore-table-to-point-in-time \
     --source-table-name family-greenhouse-production \
     --target-table-name family-greenhouse-restore-<date> \
     --use-latest-restorable-time \
     --billing-mode-override PAY_PER_REQUEST     # or --restore-date-time <ISO8601>
   aws dynamodb wait table-exists --table-name family-greenhouse-restore-<date>
   ```
3. **Validate before any cutover.** `ItemCount` metadata lags ~6h, so count for real with a scan:
   ```bash
   aws dynamodb scan --table-name family-greenhouse-restore-<date> --select COUNT --query Count
   # compare to the source; spot-check a known PK/SK (e.g. SK = METADATA rows)
   ```
4. **Cutover** (deliberate, reviewed — not mid-panic): point the Lambdas at the restored table by setting `TABLE_NAME` (the table name is the only thing they key on), **or** copy the needed items back into the live table. The GSIs are restored automatically.
5. **Clean up** the throwaway table when done: `aws dynamodb delete-table --table-name family-greenhouse-restore-<date>`.

Re-run this drill ~quarterly (it's cheap — a few cents on a tiny table).

## A member deleted the wrong plant or task

**Symptom:** "we deleted a plant by mistake" (or a task).

Since #670 a delete moves the item into the household trash for **30 days**.
Point the household at **Settings → Trash → Restore** — any member can do it,
and a plant comes back with its tasks, photos, care history, plant tag and
share link. Two refusals are expected, not bugs: a household at its plant cap
gets the same 402 as adding a plant (archive or upgrade first), and a task
whose plant is also in the trash says to restore the plant first.

Past 30 days, or after someone chose **Delete now**, the rows are gone and
only the PITR restore below can recover them (copy the needed items back; the
photos under `trash/` are gone too once purged, so a PITR recovery restores
rows whose images no longer exist). The daily purge is the digests function's
`{ "job": "trashPurge" }` run; its summary line is `trash.purge_run_complete`
with per-kind counts, alarmed through `*-digests-run-failed`.

## Restoring a household from its export

**Symptom:** "we deleted our household" / "I moved to a new account" / "send
you our export?" — the household has a JSON export (`GET /me/export`,
Settings → Account → Download full data) and wants it back.

Since #669 an admin restores it themselves: create a new household (or use an
empty one), then **Settings → Account → Restore a household from an archive**.
The preview lists what comes back and what does not before anything is written.
What to expect, none of which is a bug:

- **Only into an empty household** (no plants, tasks or spaces). A household
  with data answers `409 not_empty`; the fix is a new household, never a merge.
- **Restored:** every plant in every lifecycle state (notes, house rule, tags,
  catalog id, cutting links) and the tasks of active plants with their
  schedules. **Not restored:** photos (the export holds links, not pictures),
  spaces, care history, members (tasks for people not in the household come
  back unassigned, listed for re-inviting), billing (no plan, subscription or
  trial carries over) and every sitter, kiosk, tag, share, calendar or API
  link — issue new ones.
- **Plan cap:** more active plants than the household's plan allows is
  refused whole (`402 over_plan_limit`, nothing written). Upgrade first.
- **Interrupted restore** (`503 interrupted`): the response says exactly how
  many plants and tasks landed. Running the same restore again finishes it;
  rows have deterministic ids, so nothing is added twice. The household's
  METADATA row carries `archiveImportDigest` / `archiveImportStatus`
  (`in_progress` until every row is in, then `complete`).
- **Audit:** every commit that wrote logs one `archive.imported` line with
  `metadata.outcome` (`complete`, `plan_limit`, `write_failed`), the counts
  and the archive digest — never the file or a note.

- **Format versions.** Exports are version 2 since #669: version 1 plus a
  per-household `manifest` (counts and one SHA-256 per plant and task). The
  restore reads both. A version 2 file is checked against its manifest before
  anything is written; `400 manifest_mismatch` means the file is cut short or
  was edited (the response gives plant and task counts only, never content).
  Have them download a fresh export. A version 1 file has no manifest, so
  the preview says its completeness could not be checked; it is otherwise
  restored the same. A restore begun from a version 1 file cannot be finished
  from a version 2 file of the same household (a different archive:
  `409 other_archive`); finish it with the file it started from.

A newer export version than the deployed build reads is refused by name
(`400 unsupported_version`); that resolves itself once the newer build ships.

## Reset a user's two-step verification

Someone lost their authenticator app and the setup key (#671). There are no
recovery codes yet, so this is the way back in, and it is an account-takeover
path: verify first, act second.

1. **Verify.** The request must come from the account's own email address, and
   the requester must then complete a password reset (`Forgot your password?`)
   — proving they control that inbox _now_, not only that they know the
   address. A request that cannot do both is refused.
2. **Reset.** Turn the software-token factor off for that user (the Cognito
   username is the `sub`, not the email):

```sh
aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id <pool id> \
  --username <sub> \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

3. **Confirm** with `aws cognito-idp admin-get-user --user-pool-id <pool id>
--username <sub>`: `UserMFASettingList` no longer lists
   `SOFTWARE_TOKEN_MFA`. Reply that they can sign in with their password and
   set up a new authenticator under Settings → Security.

## Post-deploy test fixtures in production data

**Symptom:** a count of households, members, or plants that does not match what
the product actually has. On 2026-09-04 the production table held 38 households
against two registered users; 35 were named "Smoke Test Household" and belonged
to Cognito accounts that no longer existed. They also kept accruing rows — each
one collected a `PEST_CHECK#<date>` marker every day the background job ran.

**Cause:** `frontend/tests/e2e/post-deploy-smoke.spec.ts` creates a household
through the real API on every production deploy, and its teardown cannot run
when the job is skipped, the run is cancelled, or the runner dies.

**Now in place:** fixture rows carry `isTestFixture: true` at creation
(`TEST_FIXTURE` in `post-deploy-smoke-support.ts`), and the
`sweep-test-fixtures` job in `cd-production.yml` clears marked debris older than
three hours on every deploy, whatever happened to the smoke job.

**To check or clean up by hand** — the script is a dry run unless `--apply` is
passed, so the first command is always safe:

```bash
# What is in there, marked. Reads only.
node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production

# Delete marked fixtures older than 3h.
node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production --apply

# Pre-marker debris. Proposed on evidence — every member's Cognito user gone
# from the pool — never on the household's name. REVIEW THE DRY RUN FIRST.
node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production \
  --include-legacy --user-pool-id <production-user-pool-id>
node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production \
  --include-legacy --user-pool-id <production-user-pool-id> --apply
```

A household holding a member who is not a fixture user is always skipped and
reported, never deleted. `--max-deletes` (default 500) refuses a plan larger
than expected. If a plan proposes something that looks real, stop and read it —
the restore path above is PITR, and it is much cheaper to not delete.

**To count households honestly** while fixtures may still be present:

```bash
aws dynamodb scan --table-name family-greenhouse-production \
  --filter-expression 'entityType = :t AND attribute_not_exists(isTestFixture)' \
  --expression-attribute-values '{":t":{"S":"Household"}}' \
  --select COUNT --query Count
```
