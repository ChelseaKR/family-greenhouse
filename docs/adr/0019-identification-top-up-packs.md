# 0019 — Identification is sold by the pack beyond the plan allowance, not raised in tiers

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md)
(the per-identification price this rests on, and the "meter identification
separately" alternative it deferred); the paid-feature ideation brief §6
("What NOT to build", first bullet); `backend/src/models/identifyTopUp.ts`
(the pack, in code); `backend/src/services/identifyCredits.ts` (the balance);
`docs/billing.md` § Identification top-up packs (the contract).

## Context

Plant.id charges per call: **$0.0585 per identification** at our tier
(€0.05 × 1.17 USD/EUR, ADR 0012). It is the only bundled entitlement with a
hard per-unit vendor cost, and it is where the paid tiers lose money — the
brief measured identification at 59% of Garden's AI cost ceiling and 84% of
Greenhouse's. Every plan bundles a monthly allowance (1 / 30 / 100 after the
free-tier cut), and the pull, whenever a household hits the wall, is to raise
the allowance or add a tier with a bigger one. §6 of the brief names that as
the first trap: at $0.0585 a call, any increase in allowance at any tier is
an increase in the one line destroying the margin.

ADR 0012 already identified the right long-term shape — take identification
out of the bundle and meter it — and deferred it because it is a product
change. This is that change, in the smallest form that prices consumption:
a pack bought on top of the allowance, not a replacement for it.

## Decision

1. **Sell identification by the pack, on top of the plan allowance.**
   One product: **20 identifications for $1.99**, a one-time Stripe
   `mode: 'payment'` purchase (the withdrawn lifetime interval's mechanics),
   **valid 12 months from purchase, never auto-renewed.** Admin-only to buy,
   like every other purchase.

2. **A pack is credits, not entitlement.** It changes no cap, no plan, no
   subscription, and never writes the household METADATA row. It is a
   durable balance of pack rows (`HOUSEHOLD#{id}` / `IDCREDIT#{sessionId}`)
   that `POST /plants/identify` draws on **only after the month's plan
   allowance is spent**, soonest-expiring pack first. A household that buys
   in week one still has the pack after the allowance resets.

3. **The grant is idempotent on the Stripe Checkout Session id**, by
   construction: the session id is the pack row's key and the row is
   created with a conditional put. A redelivered webhook, a retry after a
   crash between the grant and the `STRIPE_EVENT#` ledger write, or two
   concurrent deliveries all grant nothing the second time. The ledger is
   still written, after the grant, in the same order as every other event
   (its "written after apply" ordering is unchanged and documented on
   `recordStripeEventOnce`; generalising the lifetime claim/lease pattern
   to every event is a separate, larger change and is not made here).

4. **Configuration fails closed.** The price id comes from one new env var,
   `STRIPE_PRICE_ID_IDENTIFY_TOP_UP`, with no fallback. Unset means the pack
   is not for sale in that environment: `GET /billing/plans` publishes
   `identifyTopUp.available: false`, the clients offer nothing, and
   `POST /billing/top-up/checkout` answers **400 `TOP_UP_NOT_CONFIGURED`**
   before Stripe or DynamoDB is touched. Never a substitute price, never a
   free credit.

5. **An unread balance is unknown, not zero** (ADR 0010). `GET /billing/me`
   publishes `identifyCredits: null` when the read fails; a real zero is
   `{ remaining: 0, expiresAt: null }`. On the enforced identify path a
   failed credit read fails closed (503) rather than telling the household
   its pack is empty, and the paid upstream is never hit unmetered.

## The margin, at the real unit price

Stated per pack, because that is the unit sold; the brief's "~70% gross" was
a rough figure and is not the number.

| Line                              |      20 for $1.99 |
| --------------------------------- | ----------------: |
| Price                             |             $1.99 |
| Vendor cost, 20 × $0.0585         |             $1.17 |
| **Gross margin before Stripe**    | **$0.82 (41.2%)** |
| Stripe fee, 2.9% + $0.30 on $1.99 |             $0.36 |
| Net receipt after Stripe          |             $1.63 |
| **Margin per pack after Stripe**  | **$0.46 (23.2%)** |

The fixed $0.30 is 15% of a $1.99 charge, which is why the after-fee margin
is roughly half the gross. The same arithmetic for the sizes the owner might
prefer instead (vendor cost 0.0585/credit; fee 2.9% + $0.30):

| Pack          | Vendor | Stripe | Net after fee | Margin / pack | Margin % | $/credit to buyer |
| ------------- | -----: | -----: | ------------: | ------------: | -------: | ----------------: |
| 20 for $1.99  |  $1.17 |  $0.36 |         $1.63 |         $0.46 |    23.2% |            $0.100 |
| 20 for $2.49  |  $1.17 |  $0.37 |         $2.12 |         $0.95 |    38.1% |            $0.125 |
| 30 for $2.99  |  $1.76 |  $0.39 |         $2.60 |         $0.85 |    28.4% |            $0.100 |
| 50 for $4.99  |  $2.93 |  $0.44 |         $4.55 |         $1.62 |    32.5% |            $0.100 |
| 100 for $8.99 |  $5.85 |  $0.56 |         $8.43 |         $2.58 |    28.7% |            $0.090 |

Two things to note. First, every row is margin-positive, which is the whole
point: a household that identifies beyond its allowance now pays more than
the call costs, instead of the tier absorbing it. Second, a larger pack at
the same $0.10/credit earns more per transaction only by amortising the
fixed fee; it does not change the per-credit economics, and it asks a
household that wanted "a few more" to buy fifty.

**Recommendation: launch at 20 for $1.99** (as coded). It is the sub-$2
impulse price, it fits the buyer — a Garden household that used its 30 and
needs some more, or a Seedling household that hit its 1 — and it is
margin-positive at $0.46 a pack, which is the requirement. If the owner
would rather trade the sub-$2 anchor for margin, **20 for $2.49** doubles the
per-pack margin to $0.95 (38%) without changing the pack; that is a one-line
change to `IDENTIFY_TOP_UP_PACK.priceUsd` and a new Stripe price. Do not
grow the pack size to chase the fee: 50 for $4.99 is the right SECOND pack
if packs sell, not a replacement for this one.

Marginal cost, per pack sold: **$1.17 vendor + $0.36 Stripe = $1.53** on
$1.99. DynamoDB adds one conditional put per pack and one query plus one
conditional update per credit spent — fractions of a cent.

Two caveats only an invoice settles: the 2.9% + $0.30 is Stripe's standard
US card rate (international cards, currency conversion, and Link/wallet
mixes move it, mostly upward), and the 1.17 USD/EUR in ADR 0012 is a
ceiling assumption. Neither moves the sign of any row.

## Alternatives considered

**Raise the allowance on Garden / add a bigger tier — rejected.** §6 of the
brief and ADR 0012 both say why: at $0.0585 a call every bundled
identification is subsidised, and the tiers already lose money at ceiling
on exactly this line. A pack prices the marginal call; a cap gives it away.

**Move identification out of the tiers entirely and sell only packs —
deferred.** The right eventual shape (ADR 0012's route back to annual), but
it removes an allowance paying customers were sold on day one. A pack on
top of the allowance changes nothing for anyone under their cap; the
subtraction can follow once packs have sold.

**A counter on the household METADATA row instead of pack rows — rejected.**
The METADATA row carries the `lastStripeEventCreated` ordering guard for
subscription events, and a single counter cannot keep per-pack expiry. A
row per pack keyed by the session id gives idempotency for free and lets a
second purchase never revive an expired first one.

**Reuse `POST /billing/checkout` with a new `planId` — rejected.** The pack
is not a plan; putting it in the plan schema would make every plan-shaped
guard (already-subscribed, lifetime floor, withdrawn cadence) reason about
something that is none of those. A separate route keeps both simple.

**Generalise the lifetime claim/lease ledger ordering to every event —
not done here.** The grant is idempotent by its own key, so the ordering
does not affect it; changing the ledger order for subscription events is a
broader billing-correctness change with its own tests and is left as is.

## Consequences

- **Consumption beyond the allowance is priced.** The margin-destroying line
  in ADR 0012 acquires a positive-margin path; nothing changes for a
  household under its cap.
- **Two surfaces offer the pack:** the identification budget-exhausted state
  (the moment of need) and the billing page; both in English and Spanish;
  both purchase-gated to admins, with the reason shown to members.
- **Nothing is for sale until the owner acts.** Open step: create the
  product and a ONE-TIME $1.99 price in Stripe (test mode first, then
  live), set `stripe_price_id_identify_top_up` in the environment tfvars,
  re-attest `stripe_price_ids_are_live` for production, apply. Until then
  every surface reports `available: false` and checkout refuses.
- **A household that has never subscribed has no Stripe customer.** Its
  top-up checks out by email and Stripe sends the receipt; the purchase is
  not visible in the billing portal, which needs a customer. Subscribed
  households buy on their existing customer and see it there.
- **Credits expire.** Twelve months from purchase, enforced at spend time
  and swept by TTL a month later. Expiry is shown next to the balance.
- **Follow-ups:** a client analytics event for pack purchase intent (the
  closed telemetry enum was left untouched); revisiting the price per the
  table above once packs have sold; a second, larger pack if the data says
  households want one.
