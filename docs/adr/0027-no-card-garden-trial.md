# 0027 — Every new household gets a 14-day Garden trial with no card, and falls back to Seedling on its own

**Status:** Accepted

**Date:** 2026-09-13

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md) (AI unit
cost, and what $0 buys); [ADR 0014](0014-plans-drawn-on-homes-and-hands.md) (the tiers are
drawn on homes and hands); [`docs/billing.md`](../billing.md) § _The no-card Garden trial_;
[`evals/UNIT-ECONOMICS.md`](../../evals/UNIT-ECONOMICS.md) §4a.

## Context

Seedling is generous on purpose. ADR 0014 made it "a couple and their plants": one home,
three people, twenty plants, one identification and twenty leaf-health checks a month, and
one sitter link of up to seven days. The care assistant, the Away Kit, plant tags and the
household toolkit are paid-only. The catalog's own comment is "charge at the fourth hand,
never at the second".

The consequence is that a typical two-person household with fewer than twenty plants never
reaches a cap, so it never meets anything a paid plan adds. A trial exists so that it does.
The paid plans already start with a 14-day trial, but that trial begins at Stripe Checkout,
with a card, after a household has decided to pay. It does nothing for a household that has
not seen a reason to.

## Decision

1. **Every new household starts 14 days of Garden with no card.** When the 14 days end it
   resolves to Seedling on its own. Nothing is charged, and no card is asked for to start it.

2. **App-side entitlement only.** The trial is two attributes on the household METADATA
   row, `noCardTrialStartedAt` and `noCardTrialEndsAt`, written once by
   `householdService.createHousehold` in the transaction that creates the household. No
   Stripe customer, subscription, trial, price or checkout session is created to start, run
   or end it. No Stripe path reads or writes those attributes, and the webhook write map
   (`SubscriptionWriteField`) excludes them. Prices, `stripe_price_id_*`, `payments_enabled`
   and `commercialHoldActive` are untouched.

3. **It ends on the clock, not on a job.** `noCardTrialState` (`models/plans.ts`) compares
   the time with `noCardTrialEndsAt` on every read. `getEntitledPlan` and
   `getEntitledPlanForIssuedGrant` raise a household to Garden only while that comparison
   says `active`. There is no scheduled job to miss and no write at day 14.

4. **It is never combined with Stripe.** `hasStripeEntitlementState` is true for a
   household with a subscription status, a subscription id, a lifetime purchase or a paid
   plan on file. Such a household resolves, and is metered, exactly as it was before this
   decision, whatever trial attributes its row carries. This is what protects the household
   that has been on a card-based Garden trial since 2026-09-03: its entitlement, its Garden
   AI allowances and its billing path do not change.

5. **One per account.** The same transaction writes a claim row,
   `USER#{userId} / NO_CARD_TRIAL`, conditional on it not existing. If the account already
   has one, the household is created without the trial. Two concurrent creates cannot both
   win it, and a household can never carry a trial whose claim did not commit.

   _Why the account and not the household:_ a household costs nothing to create, so a
   per-household rule alone lets one account leave and re-create households for a new trial
   each time. An account needs a confirmed email address. _Why not the email address:_ the
   claim would then have to outlive account deletion, and deleting an account deletes its
   data. The claim lives in the account's own `USER#` partition, so
   `accountCleanup.deleteUserScopedData` removes it with everything else. The bound this
   accepts is one trial per confirmed account.

6. **New households only.** Nothing backfills. A household created before this shipped has
   neither attribute and resolves as it always did.

7. **AI is metered at Seedling.** A trial household gets Garden's caps and features, the
   care assistant included, but `getMeteredPlanId` hands identify, leaf-health and chat the
   Seedling tier. Garden's caps and features cost nothing to serve; identifications (a
   prepaid Plant.id credit each), leaf-health checks and chat tokens do. Production already
   configures a Seedling chat budget at a quarter of the paid one, which its tfvars comment
   says exists for "a trial, say". Setting `NO_CARD_TRIAL_METERING_PLAN_ID` to Garden would
   reverse this.

8. **Falling back deletes nothing.** The downgrade contract the Terms already publish
   applies unchanged: data over a Seedling limit stays readable and editable, adding more is
   refused, and paid-only surfaces stop granting new things. `docs/billing.md` lists what
   happens to each kind of data. A trial-only rule that hid data or made it read-only would
   contradict the Terms' "nothing is deleted when a plan changes" and the published promise
   that existing data stays editable.

9. **The household is told in the app, and only there.** `NoCardTrialNotice` shows on the
   dashboard and in Settings → Billing: at the start, what the trial includes, that no card
   is needed and the end date; in the last three days, the date and what changes; after it
   ends, what changed. No email is sent. A trial ending moves no price, charge or
   subscription, so it is not a price change and the price-change notice rules do not apply.

10. **Success is measured from logs that already exist.** No analytics, beacon, pixel or
    cookie is added. `docs/billing.md` § _Measuring it without new tracking_ has the query.

## Worst-case AI cost of one trial household over 14 days

From production `terraform.tfvars` and the per-call ceilings in `evals/UNIT-ECONOMICS.md` §2
(Bedrock at 1.10× list, the leaf-health ceiling, Plant.id Tier A):

```
per UTC month, metered at Seedling
  leaf-health   leaf_health_monthly_cap_seedling   = 20        20 × $0.0059            = $0.11800
  chat input    chat_budget_input_tokens_seedling  = 62,500    62,500 × $1.10 / MTok   = $0.06875
  chat output   chat_budget_output_tokens_seedling = 12,500    12,500 × $5.50 / MTok   = $0.06875
  identify      IDENTIFY_ALLOWANCES.seedling       = 1         1 × $0.0585             = $0.05850
                                                                                         ────────
                                                                                         $0.31400

A 14-day trial overlaps at most two UTC months (every month is at least 28 days long),
and every meter resets on the 1st:
  at the caps                          2 × $0.31400                                     = $0.62800
```

Identify and leaf-health reserve one unit before each paid call, so they cannot pass their
caps. Chat reserves 8,000 input and 2,048 output tokens per turn and reconciles to what the
turn used, so turns already admitted can pass the cap:

```
  a turn makes at most MAX_TOOL_CALLS_PER_TURN + 1 = 6 model calls of 1,024 output tokens  = 6,144 output tokens
  a turn is admitted while committed <= 12,500 - 2,048 = 10,452 output tokens
  largest month: 212 committed, then 6 turns admitted together (212 + 5 × 2,048 = 10,452)
                 212 + 6 × 6,144                                                         = 37,076 output tokens
                 37,076 × $5.50 / MTok = $0.20392, which is $0.13517 over the cap's $0.06875
  over two months                      2 × $0.13517                                     = $0.27034

  worst case including the output overshoot   $0.62800 + $0.27034                       = $0.89834
```

The input side has no constant ceiling in the code: a call carries up to 24 history messages
of up to 4,000 characters each, plus tool results and retrieved passages. Its overshoot is
therefore not stated as a number.

Metering the trial at Garden's allowances instead would be, at the caps,
`200 × $0.0059 + $0.55 + 30 × $0.0585 = $3.485` a month, and `$6.97` over a 14-day window
that crosses a month boundary. Identification top-up credits are paid for by the household
and are in neither figure.

## Alternatives considered

**Meter the trial at Garden's AI allowances — rejected.** It shows more of what paying
adds, but at eleven times the ceiling, and it would turn every new account into thirty free
Plant.id credits a month.

**Start a Stripe trial without collecting a payment method — rejected.** It would create a
Stripe customer and subscription for every new household, which is exactly what this
decision must not do. A card-less Stripe trial also ends through the `canceled` or `paused`
paths, and those send billing emails.

**A scheduled job that moves households back — rejected.** A job can be missed, can fail
half way, and is a place where a clean-up could delete something. A derived comparison
cannot do any of those.

**Hide or lock data made during the trial — rejected.** See decision 8.

**One trial per household, with no account rule — rejected.** See decision 5.

## Consequences

- **Seedling's AI values are now live spend for trial households,** where before the chat
  pair was only a floor under a 402. Changing a Seedling value changes what every running
  trial may spend. `docs/deployment.md` says so beside the variables.
- **A household that subscribes during the trial still gets the card trial.** Checkout is
  unchanged, so a household that has not consumed the card trial gets
  `trial_period_days: 14` from the day it subscribes. The first charge can therefore come up
  to 28 days after the household was created. Changing that is a pricing decision and is left
  open.
- **The Terms are unchanged.** They describe paid subscriptions, and every sentence in them
  is still true. Whether to add a sentence about the no-card trial is left until the
  price-change notice work in #710 has landed.
- **The local dev server mirrors the trial.** Its test fixture that seeds a plan ends the
  trial, so a browser test that asks for Seedling gets Seedling.
- **Opening Settings → Billing cannot be counted per household from existing logs.**
  `GET /billing/me` is also fetched by the app shell on every page. Only checkout starts are
  attributable to a household.
