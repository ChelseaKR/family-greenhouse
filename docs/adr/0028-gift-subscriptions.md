# 0028 — A gift is prepaid months of a paid tier, priced at the monthly rate, redeemed by code, and it ends on the clock

**Status:** Proposed

**Date:** 2026-09-13

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md) (why a
discounted gift would be the annual plan under another name); [ADR 0019](0019-identification-top-up-packs.md)
(the one-time purchase mechanics this reuses); [ADR 0027](0027-no-card-garden-trial.md) (the
app-side entitlement shape this copies); [`docs/billing.md`](../billing.md) § _Gift subscriptions_;
[`evals/UNIT-ECONOMICS.md`](../../evals/UNIT-ECONOMICS.md) §4b.

## Context

A plant app is the kind of thing people give each other. Twelve days after payments went live
there are two paid tiers on sale, monthly only, and no way for anyone but a household's own admin
to pay for them. A gift is the one revenue lever that needs no campaign and no weekly effort: a
person who already likes the product pays for somebody else's months of it, and the recipient's
first experience of a paid tier is somebody they know.

Two constraints from earlier decisions shape it. ADR 0012 withdrew the annual plans because at the
verified Plant.id cost a household using its allowances costs more per month than an annual
subscription earns per month; a gift sold at a per-month discount would be that plan again, with
a bow on it. And nothing in this codebase may pause, extend or re-price a running Stripe
subscription (the price-change gate, `docs/billing.md` § _Price changes_), so a gift cannot be
stacked "under" a subscription that keeps charging.

## Decision

1. **A gift is N months (1–12) of Garden or Greenhouse, priced at the tier's monthly price
   times N, with no discount.** A gift month earns exactly what a subscription month earns and is
   metered exactly the same way, so it inherits the monthly plans' margin (70% / 76% AI-COGS at
   ceiling) and none of the annual plans' problem. Two Stripe one-time prices — one gift month of
   each tier, at the monthly amount — are charged with `quantity: N`, reconciled against the
   catalog before the Session is minted.

2. **The buyer is any signed-in member, paying with their own card, for somebody else.** The
   Checkout Session carries no `householdId` and no `client_reference_id`, and attaches no Stripe
   customer: the buyer's household is neither granted nor receipted, their housemates are not told
   what they bought, and no saved card belonging to the household admin can be offered. It is the
   one purchase route without `requireAdmin`, for that reason.

3. **The webhook creates the gift and its code, once.** A paid gift checkout writes three rows in
   one transaction — the gift keyed by the Session id (conditional, so a redelivery creates
   nothing and mints no second code), a lookup keyed by the code's hash, and the buyer's own copy
   with the code in plain text in the buyer's partition — then the event ledger. The code is 80
   bits from the OS CSPRNG in Crockford base32 (`FG-XXXX-XXXX-XXXX-XXXX`), is never stamped on a
   Stripe object, never logged, and is shown only to the account that paid, in Settings → Billing.
   No email carries it in this change.

4. **Redeeming is admin-only, rate-limited, and places two attributes on the household METADATA
   row: `giftPlanId` and `giftEndsAt`.** The same shape as the no-card trial: no Stripe object,
   nothing renews, nothing can charge the recipient, and `giftState` in `models/plans.ts` compares
   the clock with the end date on every read. The gift runs from the day it is redeemed, for
   whole calendar months (day clamped to the target month), and a code may be redeemed within
   365 days of purchase. The code is consumed in the same transaction that places the gift, each
   half conditioned, so a spent code never grants and a refused household never spends one.

5. **Entitlement: a running gift is a raise-only floor, like the lifetime floor.** It raises the
   household to the gifted tier and never lowers it; `getMeteredPlanId` meters identifications,
   leaf-health checks and chat at the gifted tier. Unlike the no-card trial it is NOT switched off
   by Stripe state: it was paid for, so a household whose subscription lapses into dunning
   mid-gift keeps the months somebody bought it. The no-card trial defers to a running gift
   (`noCardTrialState` is `none` while one runs), so a gift month is never metered at the free
   tier and the trial notice never claims allowances the household does not have.

6. **Refusals that never consume the code:** a household with a live Stripe subscription
   (`active`, `trialing`, `past_due`, `unpaid`, `paused`, or an id with no status yet — the same
   rule as the `ALREADY_SUBSCRIBED` guard, fail-closed), a lifetime tier at or above the gift, a
   gift already running (it queues: codes stay valid for a year), an unknown or malformed code
   (one answer for both, so the endpoint is not an oracle), and a code past its redeem-by date.
   The card trial (`trialConsumedAt`) is neither consumed nor granted by a gift; cancellation at
   period end is a live subscription and falls under the first rule.

7. **Falling back deletes nothing.** The downgrade contract the Terms publish applies unchanged
   at `giftEndsAt`, exactly as it does at the end of the no-card trial.

8. **Configuration fails closed, per tier.** `STRIPE_PRICE_ID_GIFT_GARDEN_MONTH` and
   `STRIPE_PRICE_ID_GIFT_GREENHOUSE_MONTH`, no fallback; blank means that tier cannot be given and
   `POST /billing/gift/checkout` answers 400 `GIFT_NOT_CONFIGURED`. Both join
   `stripe_price_ids_in_use`, so the attestation gate covers them the day they are set.

## Alternatives considered

**A discounted 12-month gift — rejected.** It is the withdrawn annual plan (ADR 0012) sold to a
different buyer; the recipient's usage is what costs, and it is unchanged by who paid.

**A Stripe subscription with a long trial, or a Stripe coupon/promotion code — rejected.** Both
create Stripe objects for the recipient, both end through Stripe lifecycle paths that send billing
emails, and a `trialing` subscription would consume the household's once-only card trial for
something that is not a trial.

**Pausing or deferring an existing subscription when a gift is redeemed — rejected.** Every way
to do it is a `subscriptions.update`, which the price-change gate exists to refuse. Refusing the
redemption, with the code kept valid, is the honest alternative.

**Emailing the code to the buyer — deferred.** The in-app list is the durable path (it survives a
lost email and needs no exactly-once machinery); the email is a courtesy and is a follow-up.

**A public, unauthenticated gift page — rejected for now.** It would be an unauthenticated
surface that creates Stripe Sessions and an email path to arbitrary addresses; requiring an
account costs a giver one sign-up and keeps the code retrievable.

## Consequences

- **Two more Stripe prices for the owner to create**, at the monthly amounts, one-time, in live
  mode, then set in tfvars and add to `stripe_price_ids_attested`. Until then the card offers
  nothing and redemption works for codes that do not yet exist — a safe no-op.
- **The Terms do not mention gifts.** `legal.terms.oneTime` describes packs and lifetime tiers;
  a gift is a third one-time purchase with its own rules (redeem-by date, runs from redemption,
  not refundable, cannot be applied to a subscribed household). That sentence is flagged in
  `docs/billing.md` § _What the Terms of Service say_ and is the owner's to write.
- **A household can still subscribe during a gift.** Checkout is unchanged, so a gifted household
  that starts a subscription gets the card trial (if unconsumed) and is then charged while the
  gift still runs. The billing page shows the gift's end date beside the plan grid; refusing the
  checkout, or starting the subscription's trial at the gift's end, is a follow-up decision.
- **Worst-case AI cost of a gift month is the tier's ceiling** ($3.49 Garden, $7.58 Greenhouse),
  against $4.99 / $9.99 received. `evals/UNIT-ECONOMICS.md` §4b.
- **The local dev server sells no gifts and holds no codes**; integration tests seed
  `giftPlanId` / `giftEndsAt` on the in-memory household.
