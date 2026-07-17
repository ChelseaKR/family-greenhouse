# Commercial status

**Effective date:** July 14, 2026
**Status:** New account registration, commercial activity, and payment collection paused

Family Greenhouse remains available as a portfolio project, technical demo, and
software-development artifact. Nothing in this repository or its demo is a
current paid offer, launch campaign, customer solicitation, statement of paid
adoption, or representation that revenue is being earned.

## Repository visibility

The source repository and its Git history are public portfolio artifacts.
Historical commits and retained design documents may contain superseded
pricing, launch, or customer-acquisition hypotheses; they are not current
offers and must be read with this dated status record. Repository visibility
does not change production authorization, expose household data, or relax any
commercial-hold control.

Before restoring public visibility on July 16, 2026, the complete Git history
was scanned for secrets, archived Lambda bundles were inspected separately,
and GitHub secret scanning plus push protection were verified active. Public
browser configuration such as the API endpoint and Cognito client identifiers
remains intentionally reproducible; credentials and customer data do not
belong in this repository.

## Controls currently in place

- [`commercial-status.json`](../commercial-status.json) is the single shared
  status source imported by the frontend and backend. It keeps the commercial
  hold active and gives this notice its effective date.
- Public plan surfaces contain no pricing amounts, billing intervals, purchase
  buttons, paid-plan registration links, upgrade controls, or customer-portal
  controls while the hold is active.
- Public landing, blog, care, pet-safety, invite, shared-plant, login, and
  confirmation surfaces contain no new-account acquisition controls. The
  stable `/register` route renders the shared status notice and an
  existing-account sign-in link, with no form or mutation.
- `POST /auth/signup` returns `503` before any Cognito request. The local server
  has the same public behavior; deterministic browser fixtures use a separate,
  exact-opt-in, non-deployed test endpoint rather than weakening that route.
- Cognito sets `allow_admin_create_user_only = true`, so direct `SignUp` calls
  are rejected at the identity boundary. Existing login, token refresh,
  password recovery, confirmation/resend for already-pending accounts, and
  administrator-created smoke-test users remain available.
- `GET /billing/plans` explicitly reports `paymentsAvailable: false` and omits
  monthly, annual, and lifetime price fields.
- Checkout and customer-portal session creation both fail before configuration,
  database, or Stripe access unless the shared hold is inactive **and** the
  runtime `PAYMENTS_ENABLED` value is exactly `1`. Repository infrastructure
  intentionally does not supply that variable.
- The commercial hold does not gate Stripe webhook code. In an environment
  with valid signature-verification configuration, it may process only
  already-originated events, including subscription cancellation state; it
  cannot create a new Checkout or customer-portal session.
- Evidence snapshot verified July 14, 2026: repository and `production`
  environment secret listings contained no `STRIPE_*` secret names; committed
  production price IDs were blank; and `stripe_price_ids_are_live` was false.
  Re-verify external secret/configuration state before every deployment rather
  than treating this dated observation as permanent.
- Stripe secrets, if used in future test work, must remain outside Git and must
  never be live-mode credentials while this hold is active.

The customer-acquisition steps, launch calendar, pricing, plan economics, and
billing setup in other documents are historical design hypotheses. Do not use
them for outreach, accept payment, provision a paid account, quote a price,
create a live Stripe product, or claim customers, subscriptions, sales, or
revenue.

## Ending the hold

Removing this notice does not enable payments. A future reactivation requires a
new dated written status decision, review of ownership and outside-activity
constraints, privacy/security and tax review, an explicit change to
`commercial-status.json`, reviewed restoration of registration and public
purchase UI, removal of the backend signup gate, a reviewed in-place Cognito
policy update with **no user-pool replacement**, explicit infrastructure wiring
for `PAYMENTS_ENABLED`, new price configuration, fresh non-production tests,
and a separately approved production deployment. Live secrets must remain in a
secret store and must never be committed.
