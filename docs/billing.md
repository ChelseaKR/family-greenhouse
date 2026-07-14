# Billing — historical implementation reference

> **Commercial activity hold — July 14, 2026.** Payments and paid-plan offers
> are disabled. The prices, Stripe flow, and setup instructions below document a
> prior product hypothesis; they are not a current offer or an authorization to
> configure billing. See [`COMMERCIAL-STATUS.md`](./COMMERCIAL-STATUS.md).

The retained architecture models Stripe-backed subscriptions and three plans
with per-tier caps. During the hold, plan-cap code may operate for technical
testing, but public plan responses omit prices, the API refuses to create new
Checkout or customer-portal Sessions, and production price identifiers remain
empty. The hold does not gate webhook handling, so a correctly configured
environment can still process cancellation and other supported,
already-originated Stripe events; a webhook cannot initiate a purchase.

## Plans

Source of truth: `backend/src/models/plans.ts`.

| Plan       | Monthly | Plants cap | Members cap | Notes                           |
| ---------- | ------- | ---------- | ----------- | ------------------------------- |
| Seedling   | Free    | 10         | 6           | Default for every new household |
| Garden     | $4.99   | 500        | 6           | 14-day free trial via Stripe    |
| Greenhouse | $9.99   | 5000       | 50          | 14-day free trial               |

Seedling's member cap is deliberately the same as Garden's, not 1 — household
sharing is a free, unrestricted capability by design (competitors like
Planta paywall it entirely; matching that would give up the product's main
differentiator). Only plant count and paid-feature depth are monetization
levers. This table previously listed 1 for Seedling, which was stale
relative to `plans.ts` and the marketing pricing page (both already say 6) —
if you're about to "fix" `plans.ts` to match a "1" you saw somewhere, don't;
check here and the marketing copy first.

Caps are enforced in:

- `POST /plants` → counts existing plants in the household, refuses creation with HTTP **402 Payment Required** if at the cap
- `POST /households/join/:inviteCode` → counts existing members, same 402 if full

The 402 response body carries a friendly explanation referencing the plan name; the frontend shows it as an error toast and links to `/settings/billing`.

## Frontend flow

```
Settings → Billing
   ▲              ▲
   │              │
Pricing CTA   Stripe Customer Portal
   │              ▲
   │              │
   ▼              │
POST /billing/checkout
   ▼
Stripe Checkout (off-site)
   ▲
   │ user pays
   │
   ▼
Stripe webhook → POST /billing/webhook
   ▼
DDB household row updated (planId, status, stripeCustomerId, ...)
```

The "Upgrade to X" button on `BillingSettings` does:

1. `billingService.startCheckout(planId)` → backend creates a Stripe Checkout Session and returns its URL
2. Frontend `window.location.href = result.url` → user lands on Stripe-hosted checkout
3. After success/cancel, Stripe redirects to `${FRONTEND_URL}/settings/billing?status={success|cancel}`
4. The settings page reads the query string and shows a friendly notice

The portal flow ("Manage subscription") is the same shape — `POST /billing/portal` returns a Stripe Customer Portal URL, frontend redirects there. Cancel + payment-method updates happen in Stripe's UI.

## Backend implementation

`backend/src/services/billing.ts` is the single billing service. Key surfaces:

```ts
getStripe(): Stripe                                       // lazy-init Stripe client
getHouseholdSubscription(householdId): Promise<...>       // read planId + Stripe IDs from DDB
updateHouseholdSubscription(householdId, fields): Promise // write back
createCheckoutSession({...}): Promise<{ url }>            // Stripe Checkout
createPortalSession(householdId, returnUrl): Promise<...> // Stripe Customer Portal
deltaForStripeEvent(event): SubscriptionDelta | null      // pure: webhook event → DDB delta
applyStripeEvent(event): Promise                          // calls deltaForStripeEvent then writes
```

`deltaForStripeEvent` is intentionally pure. The webhook handler verifies the Stripe signature, calls `deltaForStripeEvent`, and applies whatever (if anything) it returns. This keeps the test surface small — `billing.test.ts` exercises the delta logic for every Stripe event type without ever touching DDB.

Webhook events we handle:

- `checkout.session.completed` / `checkout.session.async_payment_succeeded` → record customer + subscription IDs, set status to active, set planId from the session metadata. The async event completes delayed one-time payment methods.
- `customer.subscription.created` / `customer.subscription.updated` → record latest status + period-end + planId
- `customer.subscription.deleted` → reset to seedling, status canceled

Anything else is acknowledged and ignored.

## Webhook signature verification

The webhook route is the one place we _don't_ run the JSON body parser. Stripe signs the raw bytes of the request body, and any munging breaks the signature. The handler reads `event.body` as a string and calls:

```ts
billing.getStripe().webhooks.constructEvent(rawBody, signature, secret);
```

For this to work in API Gateway:

- The route's integration must be configured with binary media types or "passthrough" body handling so the body is not re-encoded
- The Lambda receives the body as a UTF-8 string (`isBase64Encoded` should be false for `application/json` Stripe requests)
- The `stripe-signature` header must be preserved (API Gateway lowercases header names — handler tries both cases)

## Setup checklist

The retained frontend needs no Stripe key. The historical Stripe implementation
uses the variables below, but two independent controls remain ahead of them:
the repository status must be inactive and `PAYMENTS_ENABLED` must be exactly
`1`.

| Var(s)                                                           | How it's set                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `STRIPE_PRICE_ID_GARDEN` / `_GARDEN_ANNUAL` / `_GARDEN_LIFETIME` | `environments/<env>/terraform.tfvars` — NOT secret, committed  |
| `STRIPE_PRICE_ID_GREENHOUSE` / `_GREENHOUSE_ANNUAL`              | same tfvars                                                    |
| `STRIPE_SECRET_KEY`                                              | GitHub Actions secret → `TF_VAR_stripe_secret_key` (cd-\*.yml) |
| `STRIPE_WEBHOOK_SECRET`                                          | GitHub Actions secret → `TF_VAR_stripe_webhook_secret`         |
| `commercial-status.json`                                         | committed shared status; currently keeps the hold active       |
| `PAYMENTS_ENABLED`                                               | intentionally absent from repository deployment configuration  |

Empty values keep Stripe inert (the pre-billing behavior), so a half-finished
setup never breaks the app. An empty MONTHLY id makes a plan unbuyable; an empty
annual/lifetime id just hides that cadence.

The following is a historical reactivation checklist, not an instruction to
execute work during the hold:

1. Create a Stripe account; do the whole flow in **test mode** first, then repeat in live mode.
2. Create two **products** — Garden and Greenhouse (Seedling is free → no Stripe object). Add prices:
   - **Garden**: monthly $4.99, annual $39.99, one-time **lifetime** $149
   - **Greenhouse**: monthly $9.99, annual $79.99 (no lifetime)
3. Paste the five `price_…` ids into `infrastructure/environments/production/terraform.tfvars`.
4. Add `STRIPE_SECRET_KEY` (the `sk_…` key) as a GitHub Actions **repo secret**.
5. Create a Stripe **webhook endpoint** at `<API_URL>/billing/webhook` and subscribe it to the four events above. Production URL:
   ```
   https://ux8jg1lns0.execute-api.us-east-1.amazonaws.com/production/billing/webhook
   ```
6. Add the endpoint's signing secret (`whsec_…`) as the `STRIPE_WEBHOOK_SECRET` GitHub Actions repo secret.
7. Stripe → Settings → Customer Portal: allow cancel, update payment method, view invoices.
8. Complete the separate status, UI-restoration, runtime-gate, review, and
   deployment approvals in [`COMMERCIAL-STATUS.md`](./COMMERCIAL-STATUS.md).

For staging, repeat with the **test-mode** Stripe account + the staging tfvars/secrets. Use Stripe's test card `4242 4242 4242 4242` for paid flows.

## Local development

The local Express server mirrors production's hold: Checkout and portal requests
return 503 and never mutate the in-memory household. Integration tests that need
to exercise retained entitlement behavior seed an in-memory plan fixture
directly; they do not reopen a purchase path.

```
POST /billing/checkout -> 503 Payments are currently paused.
POST /billing/portal   -> 503 Billing access is currently paused.
```

This deliberately prevents local-development convenience code from becoming a
second activation path. Retained Stripe mechanics are covered with isolated
unit mocks; do not point development UI at an external billing environment
while the hold remains active.

## Plan caps and downgrades

If a household downgrades from Greenhouse → Seedling and they have 200 plants,
the cap is breached. We don't auto-delete; we just stop allowing new
creations. Billing settings shows an explicit over-limit warning explaining
that existing data remains usable while new plants/members are paused.

The household can still read/edit/delete what it has; it just can't add more
until it is back under the new cap. Support follows the same
contract rather than asking users to delete data automatically.

## Reading invoices

Invoice access goes through the Stripe Customer Portal. We don't ingest invoice line items into our DDB. If someone needs detailed reporting:

- Stripe CLI for ad-hoc queries: `stripe invoices list --customer cus_...`
- Stripe Sigma if you want SQL over your billing data
- Or build an admin tool against `stripe.invoices.list` and gate it appropriately

## Testing

- `tests/unit/services/billing.test.ts` — pure tests of `deltaForStripeEvent` for every event type, plus `getHouseholdSubscription` defaults
- `tests/integration/local-server.test.ts` — `describe('billing')` and `describe('plan limits')` blocks exercise checkout, plan-flip, plant-cap-402 against the real handlers via supertest

The webhook signature verification is _not_ unit-tested here because mocking `stripe.webhooks.constructEvent` would just be testing our mock. We rely on Stripe's official typings + the `deltaForStripeEvent` test coverage.

For end-to-end verification against Stripe directly, use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:4000/billing/webhook
stripe trigger checkout.session.completed
```
