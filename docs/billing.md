# Billing

> **Status — paid plans are live.** The commercial hold of July 14, 2026 was
> lifted on September 1, 2026 (`commercialHoldActive: false` in
> `commercial-status.json`) and the production runtime gate opened on
> September 2, 2026 (`payments_enabled = "1"`, release 0.23.3). Stripe
> Checkout and the customer portal are on for the hosted web app. The two gates
> below still decide, on every request, whether a session can be created; see
> [`COMMERCIAL-STATUS.md`](./COMMERCIAL-STATUS.md) for their current values
> and the kill switch.

The architecture is Stripe-backed subscriptions and three plans with per-tier
caps. Whenever either gate is shut — the repository hold or an environment's
runtime gate — public plan responses omit prices and the API refuses to create
new Checkout or customer-portal Sessions. Neither gate covers webhook handling,
so a correctly configured environment always processes cancellation and other
supported, already-originated Stripe events; a webhook cannot initiate a
purchase.

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

## Usage response contract

`GET /billing/me` returns the household's subscription state and two usage
representations during the compatibility window:

| Field         | Presence                          | Counter types    | Client contract                                                                |
| ------------- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `usageDetail` | Always                            | `number \| null` | Source of truth for current clients; `null` means unavailable, never zero      |
| `usage`       | Only when both counters are known | `number`         | Legacy shape for cached/older clients that do not understand nullable counters |

Both objects carry `plantCount`, `maxPlants`, `memberCount`, and `maxMembers`.
The plan caps are always known. A genuine zero remains `0`; a missing, invalid,
or unreadable metadata counter becomes `null` in `usageDetail`. If either
counter is unknown, the server omits `usage` entirely so a numeric-only client
does not coerce unknown data into a zero-value meter.

When both counters are known, the two representations are identical:

```json
{
  "planId": "seedling",
  "usage": { "plantCount": 4, "maxPlants": 10, "memberCount": 2, "maxMembers": 6 },
  "usageDetail": { "plantCount": 4, "maxPlants": 10, "memberCount": 2, "maxMembers": 6 }
}
```

Partial knowledge is preserved per field, while the legacy object is omitted:

```json
{
  "planId": "seedling",
  "usageDetail": { "plantCount": 10, "maxPlants": 10, "memberCount": null, "maxMembers": 6 }
}
```

New clients prefer `usageDetail` and fall back to `usage` when talking to an
older backend. `evaluatePlanLimits` (`frontend/src/services/billingService.ts`)
turns the counters into three states per dimension — `within`, `over`,
`unknown` — plus an `overall` that a known overage wins, an unknown counter
takes next, and `within` only when every counter is known and inside its cap.
Each dimension is evaluated independently, so an unknown member count neither
manufactures a warning nor hides a known plant overage — and, because
`unknown` is never folded into `within`, an unreadable counter cannot silently
satisfy a limit. The machine-readable contract is in
[`api-spec.yaml`](api-spec.yaml).

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

- `checkout.session.completed` / `checkout.session.async_payment_succeeded` → record customer + subscription IDs and planId from the session metadata. The async event completes delayed one-time payment methods. **Status is deliberately not written here** — the session references the subscription by id and does not carry its state, so the subscription events own the field (otherwise every trialing household was recorded as `active`). A lifetime (`mode: 'payment'`) session is the exception: it has no subscription, so it writes `active` and clears the subscription ids.
- `customer.subscription.created` / `customer.subscription.updated` → record latest status + period-end + planId
- `customer.subscription.deleted` → reset to seedling, status canceled

Anything else is acknowledged and ignored.

Four more event types are read only for the billing emails below and never
change entitlement: `invoice.paid`, `invoice.upcoming`,
`invoice.payment_failed`, `customer.source.expiring`.
`invoice.payment_succeeded` is deliberately **not** handled — Stripe emits it
alongside `invoice.paid` for the same money, and handling both would send two
receipts for one charge.

Three of these also emit a server-side product event (`backend/src/utils/serverAnalytics.ts`). The distinction that matters: every subscription checkout carries `trial_period_days: 14`, so checkout completion is a **trial start**, and the money-moved signal is the later `trialing → active` transition. See [`docs/analytics.md`](analytics.md) for the full contract — including why paid conversion keys off `customer.subscription.updated` rather than `invoice.payment_succeeded`, and how the dedupe ledger keeps an at-least-once redelivery from double-counting revenue.

## Billing emails

See [ADR 0023](adr/0023-billing-lifecycle-emails.md) for the reasoning; this is
the operational summary.

| Email                                               | Stripe event                                                                                                  | Phase          | Recipients        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- | ----------------- |
| Payment receipt (subscription)                      | `invoice.paid`                                                                                                | `charge`       | household admins  |
| Payment receipt (one-time: a pack, a lifetime tier) | `checkout.session.completed` / `.async_payment_succeeded` with `mode: 'payment'` and `payment_status: 'paid'` | `charge`       | household admins  |
| Renewal notice                                      | `invoice.upcoming`                                                                                            | `charge`       | household admins  |
| Payment failed                                      | `invoice.payment_failed`                                                                                      | `charge`       | household admins  |
| Card expiring                                       | `customer.source.expiring`                                                                                    | `charge`       | household admins  |
| Cancellation scheduled                              | `customer.subscription.updated`, `cancel_at_period_end` false → true                                          | `state_change` | household admins  |
| Cancellation complete                               | `customer.subscription.deleted`                                                                               | `state_change` | household admins  |
| Account deletion confirmation                       | `DELETE /me` (not a Stripe event)                                                                             | —              | the deleting user |

Three modules: `models/billingNotices.ts` (pure — what an event means and which
facts it actually carried), `services/billingEmailCopy.ts` (pure — `en`/`es`
copy and all `Intl` formatting), `services/billingEmails.ts` (recipients,
exactly-once, SES).

Operational notes:

- **All transactional.** Not gated on any notification preference or on the
  do-not-disturb window, and carrying no unsubscribe link. `notificationPrefs`
  is read for `timezone` only, so dates render in the recipient's zone.
- **Exactly once per recipient.** Each send takes
  `PK: STRIPE_EVENT#{eventId}`, `SK: EMAIL#{kind}#{userId}` with the same
  claim/send/finalize lease `welcomeEmail` uses. It is a _different sort key_
  from the ledger's `METADATA` row on purpose: that row is written after the
  apply so a failed apply stays retryable, and an email must not claim it.
- **Dispatch never throws.** A 5xx would make Stripe redeliver an already
  applied event. A failed send releases its marker, so replaying the event from
  the Stripe dashboard delivers it.
- **Nothing is claimed from a failed read.** An unreadable amount prints no
  number; an unreadable renewal date sends no notice; a genuinely zero invoice
  (every 14-day trial has one) sends no receipt.
- **Payment failure links Stripe's hosted invoice page** (`hosted_invoice_url`
  off the event, validated to an https `stripe.com` host) so a customer can
  settle the invoice in one click. It deliberately does not say what tier the
  household drops to: that depends on Stripe's "subscription status after all
  retries fail" setting and on whether entitlement consults
  `subscriptionStatus` (it does not on `main`; PR #364 changes that).
- **`STRIPE_CUSTOMER#{id}` pointer.** `customer.source.expiring` carries only a
  customer id, so any notice that knows both ids writes this pointer (400-day
  TTL) and that one reads it. No pointer yet ⇒ no warning, never a guess.

If nothing arrives: check that the billing Lambda has `SES_FROM_EMAIL` (an
unset sender makes `emailNotifier.sendEmail` dry-run and return `false`), then
check the endpoint actually subscribes the event
(`docs/external-services-setup.md`), then grep the logs for
`billing_email_household_unresolved`, `billing_email_no_recipient`,
`billing_email_duplicate_skipped` and `billing_email_dispatch_failed` — each
names a different reason for silence.

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

The frontend needs no Stripe key. The Stripe integration uses the variables
below, but two independent controls sit ahead of them on every request: the
repository hold must be inactive and `PAYMENTS_ENABLED` must be exactly `1`.

| Var(s)                                                           | How it's set                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `STRIPE_PRICE_ID_GARDEN` / `_GARDEN_ANNUAL` / `_GARDEN_LIFETIME` | `environments/<env>/terraform.tfvars` — NOT secret, committed                                   |
| `STRIPE_PRICE_ID_GREENHOUSE` / `_GREENHOUSE_ANNUAL`              | same tfvars                                                                                     |
| `STRIPE_SECRET_KEY`                                              | GitHub Actions secret → `TF_VAR_stripe_secret_key` (cd-\*.yml)                                  |
| `STRIPE_WEBHOOK_SECRET`                                          | GitHub Actions secret → `TF_VAR_stripe_webhook_secret`                                          |
| `commercial-status.json`                                         | committed shared status; `commercialHoldActive: false` since 2026-09-01                         |
| `PAYMENTS_ENABLED`                                               | Terraform `payments_enabled`; defaults `"0"`, set to `"1"` in the production and staging tfvars |

Empty values keep Stripe inert (the pre-billing behavior), so a half-finished
setup never breaks the app. An empty MONTHLY id makes a plan unbuyable; an empty
annual/lifetime id just hides that cadence.

A cadence can also be withdrawn from sale in code while its Stripe price stays
live: `withdrawnIntervals` on a plan (`backend/src/models/plans.ts`) makes
`GET /billing/plans` publish that cadence as `null` — the client already renders
that as "not available" — and makes `POST /billing/checkout` refuse it. The
price and its env var stay on the plan so that renewals on an existing
subscription still resolve to the right tier and the portal keeps managing
them. As of 2026-09-02 both annual cadences and Garden lifetime are withdrawn
(their AI-cost ceiling per household exceeds their monthly revenue); do not
archive those Stripe prices — existing subscriptions renew against them.

`payments_enabled` is per-environment, but `commercial-status.json` is shared
across both. Staging can therefore be opened for verification while production
stays shut, and the fail-closed client behaviour covers the gap: with the
status file lifted but an environment's `payments_enabled` still `"0"`, that
environment's API keeps reporting `paymentsAvailable: false` and the paid UI
renders the unavailable notice rather than a price. Today both environments are
open — production against live-mode Stripe, staging against test mode.

This checklist was completed for staging (test mode) and production (live
mode) when the hold was lifted; it is the procedure for any new environment.
`docs/COMMERCIAL-STATUS.md` holds the ordered runbook these steps sit inside:

1. Create a Stripe account; do the whole flow in **test mode** first, then repeat in live mode.
2. Create two **products** — Garden and Greenhouse (Seedling is free → no Stripe object). Add prices:
   - **Garden**: monthly $4.99, annual $39.99, one-time **lifetime** $149
   - **Greenhouse**: monthly $9.99, annual $79.99 (no lifetime)
   - Annual and lifetime prices are kept for existing subscribers but are
     withdrawn from sale (`withdrawnIntervals`); only monthly can be started.
3. Paste the five `price_…` ids into `infrastructure/environments/production/terraform.tfvars`.
4. Add `STRIPE_SECRET_KEY` (the `sk_…` key) as a GitHub Actions **repo secret**.
5. Create a Stripe **webhook endpoint** at `<API_URL>/billing/webhook` and subscribe it to the four events above. Production URL:
   ```
   https://ux8jg1lns0.execute-api.us-east-1.amazonaws.com/production/billing/webhook
   ```
6. Add the endpoint's signing secret (`whsec_…`) as the `STRIPE_WEBHOOK_SECRET` GitHub Actions repo secret.
7. Stripe → Settings → Customer Portal: allow cancel, update payment method, view invoices.
8. Open the two gates — `commercialHoldActive: false` and
   `payments_enabled = "1"` — with the reviews and approvals in
   [`COMMERCIAL-STATUS.md`](./COMMERCIAL-STATUS.md).

For staging, repeat with the **test-mode** Stripe account + the staging tfvars/secrets. Use Stripe's test card `4242 4242 4242 4242` for paid flows.

## Local development

The local Express server never creates Stripe sessions, whatever the gates say:
Checkout and portal requests return 503 and never mutate the in-memory
household. Integration tests that need to exercise entitlement behavior seed an
in-memory plan fixture directly; they do not open a purchase path.

```
POST /billing/checkout -> 503 Payments are currently paused.
POST /billing/portal   -> 503 Billing access is currently paused.
```

This deliberately prevents local-development convenience code from becoming a
second activation path. Stripe mechanics are covered with isolated unit mocks;
do not point development UI at an external billing environment.

For `GET /billing/me`, the local server computes plant and member totals from
its in-memory records. Those reads have no unseeded or unavailable state, so
local responses include both `usage` and `usageDetail` with the same numeric
values. This is an intentional parity limit, not a claim that production
counters are always available. The nullable and partial-counter paths are
covered by the household-usage service, billing-handler, and frontend billing
tests instead of a synthetic local-server failure switch.

## Plan caps and downgrades

If a household downgrades from Greenhouse → Seedling and they have 200 plants,
the cap is breached. We don't auto-delete; we just stop allowing new
creations. Billing settings shows an explicit over-limit warning explaining
that existing data remains usable while new plants/members are paused. When a
counter cannot be read, it shows a third, distinct notice saying the check
could not be made — never the silent absence of a warning, which reads as
"you're under your limit".

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
- `tests/unit/services/householdUsage.test.ts` and `tests/unit/handlers/billing.test.ts` — genuine-zero, partial/invalid counter, read-failure, and compatibility response shapes
- `frontend/tests/unit/features/BillingSettings.test.tsx` — nullable meters, legacy fallback, independent per-dimension evaluation, and the invariant that an unknown counter never resolves to `within`
- `tests/integration/local-server.test.ts` — `describe('billing')` and `describe('plan limits')` blocks exercise checkout, local `usage`/`usageDetail` parity, plan-flip, and plant-cap-402 via supertest
- `tests/unit/models/billingNotices.test.ts` — every event → notice mapping, and the honesty rules: unreadable amounts/dates/expiry render as `null`, a zero invoice sends nothing, and the endpoint's documented event list is held to the code
- `tests/unit/services/billingEmailCopy.test.ts` — both languages for every email, `Intl` money (including a zero-decimal currency) and dates in the recipient's timezone, and the rule that an unknown amount prints no number
- `tests/unit/services/billingEmails.test.ts` — admins-only recipients, sends although every preference is off, the redelivered-webhook-sends-no-second-receipt case, marker release on a dry run, and the customer pointer
- `tests/unit/services/billingEmailWebhook.test.ts` — the two dispatch phases in `applyStripeEvent`, and that a delivery the guards decline sends no cancellation confirmation

The webhook signature verification is _not_ unit-tested here because mocking `stripe.webhooks.constructEvent` would just be testing our mock. We rely on Stripe's official typings + the `deltaForStripeEvent` test coverage.

For end-to-end verification against Stripe directly, use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:4000/billing/webhook
stripe trigger checkout.session.completed
```
