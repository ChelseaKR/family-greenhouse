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
  `PAYMENTS_ENABLED` value is exactly `1`. Repository infrastructure does not
  provide that variable, production price IDs remain blank, and
  `stripe_price_ids_are_live` remains false.
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
and tax review, explicit `PAYMENTS_ENABLED` infrastructure wiring, reviewed
price configuration, fresh non-production tests, restored paid-plan UI, and a
separately approved production deployment. Live secrets must remain in a secret
store and must never be committed.
