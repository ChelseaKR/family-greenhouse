# 0012 — Identification has a real per-call cost, and at that cost the annual and lifetime plans lose money

**Status:** Accepted

**Date:** 2026-09-02

**Deciders:** Chelsea Kelly-Reif

**Related:** [`evals/UNIT-ECONOMICS.md`](../../evals/UNIT-ECONOMICS.md) (the
analysis this decision rests on); `backend/src/config/upstreamCosts.ts` (the
number, in code); implementing branches `feat/withdraw-annual-and-lifetime`
and `feat/tier-aware-ai-caps`.

## Context

Paid plans went live on 2026-09-01. The unit-economics analysis written the
next morning priced every AI call from committed constants except one: the
Plant.id per-call price, which was recorded nowhere in the repository and was
carried as a variable, `P`. It said plainly that `P` decided whether the
annual plans were healthy.

`P` was read from <https://www.kindwise.com/pricing> the same day. Plant.id is
prepaid, pay-as-you-go credits — "The cost of each identification call is one
credit" — sold in tiers from €0.05 (1,000 credits, €50 minimum) down to €0.01
(1.5M credits), EUR only, with 100 free credits on registration and an expiry
rule that on its plain reading does not touch purchases under 30,000 credits.
Our adapter sends one identification per call with `details=common_names`,
which the FAQ does not list as an extra charge (the only add-on it names is
`plant.health` in the same request, which we do not use). At our volume we are
Tier A:

```
P = €0.05 × 1.17 USD/EUR = $0.0585 per identification
```

(ECB reference rate 1.1590 on 2026-09-01; 1.17 assumed to cover the
card-conversion spread on a EUR invoice, so the figure is a ceiling.)

Every plan bundles identifications — 3 / 30 / 100 per month — on top of a
leaf-health cap and a chat budget that together cost up to $1.73 a month at
ceiling. Putting the real `P` into the analysis:

| Plan                              | Effective $/mo | AI COGS at ceiling | % of revenue | Net of Stripe                 |
| --------------------------------- | -------------- | ------------------ | ------------ | ----------------------------- |
| Seedling (free)                   | $0.00          | $1.91              | ∞            | ∞                             |
| Garden monthly                    | $4.99          | $3.49              | 70%          | 77%                           |
| **Garden annual** ($39.99/yr)     | $3.33          | $3.49              | **105%**     | **109%**                      |
| Greenhouse monthly                | $9.99          | $7.58              | 76%          | 81%                           |
| **Greenhouse annual** ($79.99/yr) | $6.67          | $7.58              | **114%**     | **118%**                      |
| Garden Lifetime ($149 once)       | —              | $3.49              | —            | payment gone in **41 months** |

A household that uses what its annual plan says it may use costs more than it
pays, before any infrastructure. Lifetime burns its whole payment in under
three and a half years and has no lever to re-price. The free tier, with the
same leaf-health and chat caps as the $9.99 tier, can spend $1.91 a month
against $0.

These are ceilings. Most households will not reach them, and the expected cost
is lower. But a subscription cannot be sold on the hope that customers do not
use it, and the annual plans are the ones the catalog says the business
monetizes on.

## Decision

1. **Garden annual, Greenhouse annual, and Garden Lifetime are withdrawn from
   sale.** Existing subscribers keep their plans and their renewals; nothing
   changes for anyone who already bought. Monthly plans stay on sale at their
   current prices. Implementation: `feat/withdraw-annual-and-lifetime`.

2. **The free tier's AI caps drop to 20 leaf-health checks, 1 identification,
   and 25% of the chat budget per month.** Paid caps are unchanged — a paying
   customer's allowance is not reduced. The free-tier ceiling falls from $1.91
   to $0.31 a month. Implementation: `feat/tier-aware-ai-caps`.

3. **The price is written down where code and analysis can both read it.**
   `PLANT_ID_USD_PER_CREDIT` in `backend/src/config/upstreamCosts.ts`, default
   `0.0585`, overridable by env, logged as `costUsd` on every configured
   identification under `plant_id_identify`. It is cost accounting only; no
   cap reads it. (This PR.)

## Alternatives considered

**Reprice annual at $49.99 / $99.99 (about 17% off monthly instead of 33%) —
rejected for now.** At ceiling Garden annual would run 84% gross / 87% net and
Greenhouse annual 91% / 94%. That moves them from losing money to keeping
almost none — too thin to relaunch a plan on, and a price rise on day two of
paid plans with nothing new behind it. It is the likely price point once
identification is metered (below).

**Meter identification separately as a paid add-on — rejected for now.**
This is the right long-term shape: it is the one bundled entitlement with a
hard per-unit vendor cost, and taking it out of the bundle is what makes annual
work — with identification metered out, annual at today's prices runs 52% /
26% at ceiling, and at $49.99 / $99.99, 42% / 21%. But it is a product change
(a meter, a price, a purchase flow, copy in two languages) and should not gate
today's fix. It is the path back to annual, not a substitute for withdrawing it.

**Buy a higher Kindwise tier — not a fix.** Tier B (€300 for 10,000 credits,
which do not expire) cuts `P` to $0.0351 and Garden annual to 84%; Tier C
(€1,000) to $0.0234 and 73%. Greenhouse annual: 79% and 61%. No tier reaches a
subscription-grade margin on an annual plan. Tier B does take Garden monthly
from 70% to 56% at ceiling and is worth doing on its own merits once volume
justifies the outlay; the constant stays parametric for that.

**Withdraw only Lifetime, keep annual — rejected.** Annual is the larger
exposure (more buyers, and over 100% at ceiling); Lifetime is the same defect
with a longer fuse.

**Keep everything and cut the paid caps — rejected.** Reducing a paying
customer's allowance on the second day of paid plans is a broken promise, and
Greenhouse is already tight (200 leaf-health checks across up to 50 members).

## Consequences

- **New customers can buy monthly only.** The annual toggle, "billed yearly"
  copy, and the Lifetime card come off the pricing surfaces. The Stripe prices
  are not deleted — existing annual subscribers renew on them.
- **The exposure from existing annual and lifetime holders is bounded and
  known**: at most $0.15/month per Garden annual, $0.91/month per Greenhouse
  annual, and one Lifetime payment exhausted after 41 months at ceiling. It is
  carried, not hidden.
- **The free tier gets materially less AI.** 20 leaf-health checks, 1
  identification, a quarter of the chat budget. That is what $0 buys; the
  previous caps were the $9.99 tier's.
- **The cost of a round-trip to annual is now explicit.** Meter identification
  (add-on), then relaunch annual at $49.99 / $99.99; the arithmetic for both
  steps is above and in `evals/UNIT-ECONOMICS.md`.
- **Two things only an invoice settles**: the true card-conversion spread the
  1.17 assumption stands in for, and whether failed calls are charged. Neither
  changes the decision at any plausible value.
- **Follow-ups**: plumb `plant_id_usd_per_credit` through Terraform beside the
  Bedrock cost variables (it is read by the code but not yet wired); sum
  `plant_id_identify.costUsd` monthly against the Kindwise balance.
