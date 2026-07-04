# Billing

Stripe-backed subscriptions. Three plans with per-tier caps that the API enforces server-side, plus a customer-portal escape hatch so we don't have to build account-management UI ourselves.

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

- `checkout.session.completed` → record customer + subscription IDs, set status to active, set planId from the session metadata
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

Before you can take payments:

1. Create a Stripe account, switch to test mode, then live mode
2. Create the **products** (Seedling/Garden/Greenhouse) in Stripe — Seedling is metadata-only since it's free; the other two get monthly prices
3. Copy the **price IDs** for Garden and Greenhouse → set `STRIPE_PRICE_ID_GARDEN` and `STRIPE_PRICE_ID_GREENHOUSE` on the backend Lambdas
4. Set `STRIPE_SECRET_KEY` on the backend
5. Create a Stripe webhook endpoint pointing at `https://api.family-greenhouse.example.com/billing/webhook`, subscribe it to the four events above
6. Copy the webhook signing secret → set `STRIPE_WEBHOOK_SECRET` on the webhook handler Lambda specifically (not on the others)
7. In Stripe → Settings → Customer Portal, configure what users can do (cancel, update payment method, view invoices). We allow all three.

For staging, do the same with the test-mode Stripe account. Use Stripe's test card `4242 4242 4242 4242` for paid flows.

## Local development

The local Express server bypasses Stripe entirely. `POST /billing/checkout` flips the household's plan immediately and returns a stub success URL:

```
[billing] dev-mode upgrade: <householdId> -> garden. (Stripe is bypassed.)
```

This lets the upgrade flow be exercised end-to-end (including plan-cap enforcement) without a Stripe account. The "Manage subscription" button hits a similarly stubbed `/billing/dev-portal` page.

To exercise the _real_ Stripe integration in dev, point the frontend at a staging API instead and use Stripe test cards.

## Plan caps and downgrades

If a household downgrades from Greenhouse → Seedling and they have 200 plants, the cap is breached. We don't auto-delete; we just stop allowing new creations. The dashboard could show a "you are over your plan limits" banner — that UI isn't built yet.

For now: downgrades are best-effort. The household can still read/edit/delete what they have; they just can't add more until they're back under the new cap. Document this in the support FAQ once we have one.

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
