# Commercial status

**Paid-activity hold effective:** July 14, 2026

**Free registration reopened:** July 19, 2026
**Status:** Free accounts open; paid plans and payment collection paused

Family Greenhouse accepts free accounts for households with up to 10 plants.
No credit card is required. The hosted app does not currently offer paid plans,
collect payments, create purchases, process upgrades, or allow plan changes.

The source repository and its history remain public portfolio artifacts.
Historical pricing, launch, and customer-acquisition documents are design
hypotheses, not current offers or evidence of revenue.

## Current controls

- [`commercial-status.json`](../commercial-status.json) is the shared status
  source imported by the frontend and backend. Registration is available only
  when `publicRegistrationAvailable` is exactly `true`; the paid-activity hold
  remains independently active.
- The `/register` route and public acquisition links offer the Seedling free
  account. `POST /auth/signup` validates the 12-character Cognito password
  policy (uppercase, lowercase, and digit), is rate-limited, and creates an
  unconfirmed user who must verify their email.
- Cognito explicitly permits public self-signup
  (`allow_admin_create_user_only = false`). This is an in-place user-pool policy
  change, not a pool replacement.
- Public plan surfaces expose no paid prices, billing intervals, purchase or
  upgrade controls, or customer-portal controls while the hold is active.
- `GET /billing/plans` reports `paymentsAvailable: false` and omits monthly,
  annual, and lifetime price fields.
- Checkout and customer-portal creation fail before configuration, database,
  or Stripe access unless the paid hold is inactive **and** the runtime
  `PAYMENTS_ENABLED` value is exactly `1`. That variable is now wired through
  Terraform (`payments_enabled`) but defaults to `"0"` at both the module and
  root layer and is committed as `"0"` in every environment. Production price
  IDs remain blank and `stripe_price_ids_are_live` remains false.
- `terraform_data.commercial_gate_guard` carries three **preconditions** that
  fail the plan — not `check` blocks, which only warn and would let
  `terraform apply` proceed unread in CI. Enabling `payments_enabled` fails
  unless the repository hold is also lifted, the Stripe secret/webhook/monthly
  price IDs are all populated, and a live key is paired with a confirmed
  `stripe_price_ids_are_live`.
- The paid-plan UI exists and is fully built, but every purchase surface is
  gated on the API's own `paymentsAvailable` field rather than on the
  compile-time constant, so a frontend deployed ahead of its backend degrades
  to the hold notice instead of advertising prices the server will refuse.
- The paid hold does not gate Stripe webhook verification for already-originated
  events such as subscription cancellation; it cannot originate a new Checkout
  or portal session.

## Closing registration again

Set `publicRegistrationAvailable` to `false`, deploy the backend before removing
public signup controls, and set Terraform's `public_registration_enabled` to
`false` so Cognito applies `allow_admin_create_user_only = true`. Keeping an
application gate and an identity-boundary gate makes a future pause deliberate
and fail-closed. The Cognito app-client ID is necessarily public, so direct
Cognito `SignUp` calls bypass the hosted API gate and its per-container limiter
while pool self-signup is open; the Terraform policy is the authoritative
emergency-stop control.

## Ending the paid-activity hold

Free registration does not enable payments. Restoring paid activity requires a
new dated status decision, ownership/outside-activity review, privacy/security
and tax review, reviewed price configuration, fresh non-production tests, and a
separately approved production deployment. Live secrets must remain in a secret
store and must never be committed.

The engineering work is complete; what remains is configuration and approval.
The steps below are the whole remaining sequence, in order. Nothing before
step 6 can charge anyone.

### 1. Record the decision

Add the new dated decision to this file, with the reviews it rests on. Update
`commercial-status.json`'s `effectiveDate` and the assertion in
`backend/tests/unit/config/commercialStatus.test.ts` that pins it.

### 2. Configure Stripe in TEST mode

Create both products and their prices in Stripe **test mode**, then set the
five `stripe_price_id_*` values in `infrastructure/environments/staging/terraform.tfvars`.
Add `STAGING_STRIPE_SECRET_KEY` (`sk_test_…`) and `STAGING_STRIPE_WEBHOOK_SECRET`
(`whsec_…`) as GitHub Actions secrets; `cd-staging.yml` forwards both as
`TF_VAR_…`. Point a Stripe test webhook at the staging API's
`/billing/webhook` and subscribe the five events listed in `docs/billing.md`.

### 3. Open both gates in staging only

Set `payments_enabled = "1"` in the staging tfvars **and** `commercialHoldActive`
to `false` in `commercial-status.json`. The guard refuses a plan that opens one
without the other. Note that the status file is shared, so this is the step
where the paid UI becomes visible everywhere — production stays safe because
its own `payments_enabled` is still `"0"`.

### 4. Stand staging up, then verify the full loop

**There is no standing staging environment.** `cd-staging.yml` is
`workflow_dispatch` only and the staging Terraform state holds zero resources;
a staging apply provisions a complete separate stack (Cognito, DynamoDB, API
Gateway, CloudFront) and costs money for as long as it exists. Dispatch the
workflow to create it, take the API URL from the Terraform output, point the
Stripe test webhook at `<that URL>/billing/webhook`, run the checks below, and
`terraform destroy` the staging state when finished.

The Stripe CLI (`stripe listen --forward-to localhost:4000/billing/webhook`)
is a cheaper first pass and catches most breakage, but it cannot substitute
for the hosted run: it bypasses API Gateway, which is exactly where raw-body
handling and webhook signature verification fail. That failure is expensive —
the customer is charged and entitlement never lands.

#### Standing staging up and tearing it down

Staging is disposable by design and costs nothing while destroyed. Its
Terraform state is isolated under the `staging/terraform.tfstate` key, so a
teardown cannot reach production.

**Up** — run the `Deploy to Staging` workflow (Actions → Deploy to Staging →
Run workflow); it is `workflow_dispatch` only, deliberately. Then read the API
URL locally:

```bash
cd infrastructure
terraform init -reconfigure -backend-config="key=staging/terraform.tfstate"
terraform output api_url
```

**Down** — from that same init:

```bash
terraform destroy -var-file=environments/staging/terraform.tfvars
```

CloudFront takes roughly 15–20 minutes in each direction; everything else is
quick.

What makes the cycle repeatable, and what to keep that way:

- The frontend and images buckets set `force_destroy = var.environment !=
"production"`. Without it a destroy fails on the deployed site and any
  uploaded photos, stranding a half-destroyed stack that still bills. **Do not
  extend this to production** — there, a non-empty bucket is the wall an
  accidental destroy should hit.
- Bucket versioning is already `Suspended` outside production, so no object
  versions survive a teardown.
- Bucket names carry a `random_id` suffix, so a fresh apply never collides
  with a name still being deleted.
- A rebuild produces a **new API URL and a new Cognito pool**, so the Stripe
  test webhook must be re-pointed each cycle. Prefer completing the checks
  below in one sitting.
- `modules/email/inbound.tf` names its bucket by AWS account, not environment,
  so staging and production would collide over it. It is dormant only because
  staging sets `domain_name = ""` (`count = 0`). Fix that naming before ever
  giving staging a domain.

Idle cost while a staging stack is left _running_ is small but not zero —
about 15 CloudWatch alarms plus log and S3 storage. There are no NAT gateways,
Elastic IPs, KMS customer keys, or hosted zones in the stack, and DynamoDB is
`PAY_PER_REQUEST`, so destroying takes it to effectively zero.

Using Stripe test card `4242 4242 4242 4242`:

- monthly, annual, and lifetime checkout each complete and grant entitlement
- the webhook updates the household's plan (entitlement comes from the
  webhook, never from the checkout response)
- the billing portal opens, and a plan change made there re-resolves
  entitlement from the price id, not stale metadata
- a second purchase attempt on a live subscription is refused with 409
- a lifetime purchase cancels the prior subscription
- cancelling returns the household to Seedling at period end

### 5. Configure Stripe in LIVE mode

Repeat step 2 in live mode. Set the production `stripe_price_id_*` values,
update the corresponding assertion in `commercialStatus.test.ts`, and set
`stripe_price_ids_are_live = true` only after manually confirming every id was
created in live mode — Terraform cannot detect a mode mismatch, because price
ids look identical in both.

### 6. Deploy production

Set `payments_enabled = "1"` in the production tfvars as its own reviewed
change, then run the production deployment. `cd-production.yml` already orders
`deploy-backend` before `deploy-frontend`, so the API accepts checkout before
the UI offers it.

### Rolling back

Returning `payments_enabled` to `"0"` and applying stops all new payment
activity within one Terraform run — no code change, no frontend deploy. It
fails before Stripe or DynamoDB access, so nothing new can be originated. It
does **not** hide the paid UI, which reads the API's `paymentsAvailable` and
will correctly show the paused notice; and it does not touch existing
subscriptions, whose cancellation webhooks keep processing by design. To also
withdraw the offer, set `commercialHoldActive` back to `true` and deploy the
frontend.
