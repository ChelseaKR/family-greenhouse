# AI unit economics — what each call costs, and whether a paying customer pays for it

**Written 2026-09-02, against `origin/main` @ `cd149db`.** Paid plans went live
2026-09-01 (`commercial-status.json`), so every AI call now has a margin
consequence as well as a quality one. `evals/README.md` covers the quality
half; this file covers the cost half.

**No live model calls were made to produce this.** Every figure below derives
from constants committed in this repository plus published list prices. Where
a number is not in the repo it is left as a variable rather than guessed. See
[Verifying this for free](#verifying-this-for-free) for how to replace the
estimates with measurements without spending anything.

**Updated 2026-09-02.** The one variable this document was built around — the
Plant.id per-call price, `P` — was read from the vendor's pricing page the same
day and is now written down (§2, and `backend/src/config/upstreamCosts.ts`).
§4 is recomputed against it, with the parametric form kept beside the real
number for when the tier or the exchange rate moves. The result forced three
decisions, recorded in
[ADR 0012](../docs/adr/0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md).

---

## 1. What ships, and on what

| Feature              | Route                            | Provider / model                                                    | Cost shape                                                                                                      |
| -------------------- | -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Plant identification | `POST /plants/identify`          | **Plant.id** (third party)                                          | One prepaid credit per call — €0.05 (Tier A) ≈ **$0.0585**; see §2                                              |
| Leaf-health check    | `POST /plants/{id}/health-check` | **Bedrock**, `us.anthropic.claude-haiku-4-5-20251001-v1:0` (vision) | Per-token                                                                                                       |
| Chat assistant       | chat handlers → `services/chat/` | **Bedrock**, same Haiku 4.5 profile                                 | Per-token                                                                                                       |
| Corpus embeddings    | build-time                       | Titan (precomputed, committed)                                      | **$0 at runtime** — `plant-care-corpus-embeddings.json` is a committed artifact; nothing embeds at request time |

Both Bedrock features share one model id (`BEDROCK_CHAT_MODEL_ID`, defaulting
in code to the `us.` inference profile). Haiku 4.5 lists at **$1.00 / MTok
input, $5.00 / MTok output**, which is exactly what `services/chat/bedrock.ts`
already encodes as `BEDROCK_INPUT_USD_PER_MTOK` / `BEDROCK_OUTPUT_USD_PER_MTOK`.

⚠️ The `us.` prefix is a **cross-region inference profile**, which carries a
regional-endpoint premium (measured at **1.10×** on another Bedrock workload in
this same AWS account). If it applies here, the repo's own `costUsd` telemetry
is ~10% low. Both columns are shown below; the ceilings use the 1.10× figure so
they stay ceilings.

---

## 2. Cost per call

### Leaf-health check

Input is dominated by the image. Anthropic bills images at roughly
`(width × height) / 750` tokens, and resizes anything larger than ≈1.15 MP
before tokenising — so a single image cannot exceed **≈1,600 tokens** no matter
what is uploaded. The system prompt in `leafHealth.ts` is ~250 tokens and the
user text ~22.

|                                                                                 | Image tokens | Total input | Output | @ $1/$5 | @ $1.10/$5.50 |
| ------------------------------------------------------------------------------- | ------------ | ----------- | ------ | ------- | ------------- |
| **Typical** — client downscale to 1024px long edge (`LEAF_PHOTO_MAX_EDGE`), 4:3 | ~1,050       | ~1,320      | ~250   | $0.0026 | **$0.0028**   |
| **Ceiling** — provider-capped image, `MAX_OUTPUT_TOKENS = 700` fully used       | ~1,600       | ~1,870      | 700    | $0.0054 | **$0.0059**   |

So **a leaf-health check costs roughly a third of a cent, and cannot exceed
about six tenths of a cent.**

> **Byte cap ≠ pixel cap.** `healthCheckSchema` caps `imageBase64` at 350,000
> characters (~256 KiB binary) and `bodySizeGuard` at 400 KiB — but token cost
> scales with _pixels_, not bytes, and a 256 KiB JPEG can encode 12 MP. The
> 1024px downscale is a **client** behaviour; the server accepts whatever a
> patched client sends. The ceiling above holds only because the _provider_
> resizes — i.e. the bound is someone else's, not ours. Today that is fine (the
> blast radius is ~1.6× on the input half of a sub-cent call), but it is worth
> knowing the guard is not where you would think it is.

### Chat

Bounded by budget, not by call: `CHAT_BUDGET_INPUT_TOKENS = 250,000` and
`CHAT_BUDGET_OUTPUT_TOKENS = 50,000` per household per month (`services/chat/index.ts`;
the Terraform variables default to `""`, meaning "use the code default").

- 250,000 input × $1.10/MTok = $0.275
- 50,000 output × $5.50/MTok = $0.275
- **≈ $0.55 / household / month at the cap** ($0.50 at list).

### Identification

**Verified 2026-09-02 against <https://www.kindwise.com/pricing> and the
Kindwise FAQ.** Plant.id is prepaid, pay-as-you-go credits — not a
subscription. The pricing page's rule is one sentence: **"The cost of each
identification call is one credit."** Credits are bought in tiers, priced in
EUR only:

| Tier | Credits   | € / credit | Minimum purchase |
| ---- | --------- | ---------- | ---------------- |
| A    | 1,000     | €0.05      | €50              |
| B    | 10,000    | €0.03      | €300             |
| C    | 50,000    | €0.02      | €1,000           |
| D    | 200,000   | €0.015     | €3,000           |
| E    | 800,000   | €0.012     | €9,600           |
| F    | 1,500,000 | €0.01      | €15,000          |

Also on the page: **100 free credits after registration**; a prepaid mode and
a "retroactive" (monthly-invoiced) mode for long-term clients; and the expiry
rule, quoted exactly because it is easy to misread — _"Purchased credits are
valid for 3 months (this does not apply to purchases under 30 000 credits)."_
On the plain reading, credits from a purchase **under** 30,000 do not expire,
so a Tier A or Tier B purchase sits until used; only a Tier C-or-larger buy is
on a three-month clock. Confirm with Kindwise before any purchase of 30,000 or
more.

**What our call costs.** `services/plantIdentification.ts` sends one
`POST /v3/identification` with `?details=common_names` and
`similar_images: false`. The FAQ says _"Each successful identification deducts
1 credit"_ and names exactly one thing that adds a second credit — using
`plant.health` in the same request, which we do not. The `details` parameter
is not listed as a charge; the separately-billed item is the Detail _endpoint_
(0.5 credits per lookup), a different call the adapter never makes. So our
call is **one credit**. Two things the FAQ does not say and an invoice will:
whether a failed or timed-out call is charged ("successful" suggests not), and
whether `details` on the identification call is ever billed like the Detail
endpoint. Until then, one credit per call is the vendor's own statement, and
it is what this document uses.

**The exchange rate.** Prices are EUR only. The ECB reference rate on
2026-09-01 was **1.1590 USD/EUR**; this document and the code assume
**1.17** — about 1% above — to absorb the card-conversion spread on a EUR
invoice paid in USD, so the accounted figure stays a ceiling.

```
P  =  €0.05 × 1.17 USD/EUR  =  $0.0585 per identification   (Tier A)
```

That is `PLANT_ID_USD_PER_CREDIT` in `backend/src/config/upstreamCosts.ts`,
overridable per environment with the env var of the same name (read by the
code; not yet a Terraform variable, so the default is what runs). The identify
handler logs it as `costUsd` on every configured call under
`plant_id_identify`, in the same shape as `bedrock_invoke`. It is accounting,
not gating: no cap reads it.

Kept parametric, because it moves with the tier and the rate:

| Tier         | € / credit | P @ 1.17 USD/EUR | P @ 1.10 | P @ 1.25 |
| ------------ | ---------- | ---------------- | -------- | -------- |
| **A (ours)** | €0.05      | **$0.0585**      | $0.0550  | $0.0625  |
| B            | €0.03      | $0.0351          | $0.0330  | $0.0375  |
| C            | €0.02      | $0.0234          | $0.0220  | $0.0250  |

---

## 3. What the caps actually enforce

Traced, not assumed:

| Guard              | Bucket                                           | Cap                                | Tier-aware? | Enforced where                                                                                                                                             |
| ------------------ | ------------------------------------------------ | ---------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identifyBudget`   | household, or `user:{userId}` when householdless | **3 / 30 / 100** per month by plan | **Yes**     | Production only — `identify_metering_enabled = "1"` in `environments/production/terraform.tfvars`. Default and staging are **tracking-only, no blocking**. |
| `leafHealthBudget` | household                                        | **200** per month                  | **No**      | Always. `LEAF_HEALTH_MONTHLY_CAP` appears nowhere in `infrastructure/`, so the code default 200 is what runs. `<= 0` disables the gate.                    |
| chat token budget  | household                                        | **250k in / 50k out** per month    | **No**      | Always.                                                                                                                                                    |
| rate limits        | user, in-memory per warm container               | identify 10/min, leaf-health 5/min | No          | **Best-effort only** — the real ceiling is _N containers × max_, which is why the durable monthly caps exist.                                              |

**The engineering here is good and worth saying so.** All three durable caps
reserve through a _conditional_ DynamoDB `ADD` (`reserveUsage`) before the paid
call, so concurrent requests cannot all observe the same under-cap total and
overspend. That is the correct pattern, and the code comments show it was a
deliberate fix rather than an accident.

---

## 4. The margin question

Maximum AI cost of one household per month, all three features at their caps,
using the 1.10× rates and the leaf-health _ceiling_, with `P` from §2:

```
leaf-health   200 × $0.0059  = $1.18
chat          at budget       = $0.55
identify      allowance × P     P = $0.0585 (Tier A, 1.17 USD/EUR)
                              ─────────────────────────────
Seedling (free)   $1.73 +   3P  =  $1.91
Garden            $1.73 +  30P  =  $3.49
Greenhouse        $1.73 + 100P  =  $7.58
```

Against price. "Gross" is AI COGS over the sticker price, the basis the
earlier draft used; "net" first takes Stripe's 2.9% + $0.30 off each charge
(one charge a month, or one a year spread over twelve).

| Plan                              | Effective $/mo | AI COGS at ceiling | % of revenue, gross | % net of Stripe | Formula      |
| --------------------------------- | -------------- | ------------------ | ------------------- | --------------- | ------------ |
| **Seedling (free)**               | $0.00          | $1.91              | **∞**               | **∞**           | $1.73 + 3P   |
| Garden monthly                    | $4.99          | $3.49              | 70%                 | 77%             | $1.73 + 30P  |
| **Garden annual** ($39.99/yr)     | $3.33          | $3.49              | **105%**            | **109%**        | $1.73 + 30P  |
| Greenhouse monthly                | $9.99          | $7.58              | 76%                 | 81%             | $1.73 + 100P |
| **Greenhouse annual** ($79.99/yr) | $6.67          | $7.58              | **114%**            | **118%**        | $1.73 + 100P |

For comparison, the same table at the two guesses the earlier draft carried:
P = $0.02 gave Garden annual 70% and Greenhouse annual 56%; P = $0.04 gave 88%
and 86%. The real price is above the worse guess.

### Can a paying customer cost more than they pay?

**In a single month, on a monthly plan: no — but it is closer than it looked.**
A maxed-out Garden monthly subscriber costs $3.49 against $4.99 (70% gross,
77% net); Greenhouse monthly $7.58 against $9.99 (76%, 81%). No month goes
negative, and a household that never touches the caps costs far less. But a
monthly plan whose ceiling is three-quarters of its price has no room for the
AWS baseline, support, or a bad exchange-rate month.

**On the annual plans: yes, and by construction.** Garden annual at $3.33/mo
costs up to **$3.49** in AI alone — **105% of revenue at ceiling, 109% net of
Stripe**. Greenhouse annual at $6.67/mo costs up to **$7.58** — **114% gross,
118% net**. A household that uses what its plan says it may use costs more
than it pays, before a cent of infrastructure. These were the plans the catalog
said the business monetizes on ("the category monetizes primarily on annual
plans" — `models/plans.ts`), and at the verified price they are underwater at
the ceiling. That is the plain result, and there is no reading of the
arithmetic that softens it: the break-even `P` for Garden annual is $0.053 and
for Greenhouse annual $0.049, and Tier A is $0.0585.

**On Garden Lifetime ($149): yes, with certainty, and sooner.** $149 net of
Stripe is $144.38. At $3.49/month of AI COGS that is **41 months — under three
and a half years — to burn the entire payment on AI alone**, and every month
after that is a loss. Lifetime is the only plan with no mechanism to re-price
against its own cost, and the allowances it inherits never expire.

**And the free tier is the largest unpriced exposure.** A Seedling household —
$0 revenue — has the _same_ 200 leaf-health checks and the _same_ 250k/50k
chat budget as a $9.99 Greenhouse household, and can spend up to **$1.91/month**
at ceiling ($1.29 with typical leaf-health photos). Free households are the
most numerous ones.

**Volume purchasing does not rescue annual.** Buying Tier B (€300 for 10,000
credits, which on the expiry clause do not expire) cuts `P` to $0.0351 and
Garden annual to 84% gross; Tier C (€1,000) to $0.0234 and 73%. Greenhouse
annual: 79% and 61%. Cheaper credits move annual from "loses money" to "keeps
almost none", and no tier reaches a subscription-grade margin. The structural
fix is to take identification out of the bundle, not to buy it cheaper. (Tier B
_does_ take Garden monthly from 70% to 56% — worth doing on its own merits once
volume justifies a €300 outlay, and it is the reason `P` stays parametric.)

### The number that decided it

Everything above swings on `P`. The earlier draft said: find it, write it
down, re-run the table. It was found the same day — $0.0585, above the worse
of the two guesses — and the table above is the re-run. The decisions it
forced are recorded in
[ADR 0012](../docs/adr/0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md),
and are being implemented on `feat/withdraw-annual-and-lifetime` (Garden
annual, Greenhouse annual and Garden Lifetime withdrawn from sale; existing
holders keep their plans and renewals; monthly plans stay) and
`feat/tier-aware-ai-caps` (the free tier drops to 20 leaf-health checks, 1
identification and a quarter of the chat budget; paid caps unchanged). This
document is the analysis; the ADR is the decision.

What the free-tier change does to the ceiling in §4:

```
Seedling, before    200 × $0.0059  +  $0.55         +  3 × $0.0585  =  $1.91
Seedling, after      20 × $0.0059  +  $0.55 × 0.25  +  1 × $0.0585  =  $0.31
```

— an 84% cut at ceiling ($1.29 → $0.25 with typical leaf-health photos), on
the tier that has the most households and no revenue.

---

## 5. Findings, in priority order

**F1 — Two of the three caps are tier-blind, which inverts the intended shape.**
Identify scales 3 / 30 / 100 by plan. Leaf-health (200) and chat (250k/50k) are
_identical_ for a $0 Seedling household and a $9.99 Greenhouse household. The
free tier's most expensive entitlement is the same as the top tier's.

_Suggested fix, not applied here:_ give `leafHealthBudget` a
`LEAF_HEALTH_ALLOWANCES` record next to `identifyBudget`'s `IDENTIFY_ALLOWANCES`,
with **paid tiers at or above today's 200** and only the free tier reduced.
That is not weakening a cap — the enforced ceiling for paying users stays put or
rises; only the unpaid ceiling comes down to match its revenue. It needs a
`billing.getHouseholdSubscription` read in `handlers/plants/health.ts`, which
`identify.ts` already does, so the shape is known. **It is a pricing decision,
so it is written down rather than shipped.**

_Decided 2026-09-02 (ADR 0012): the free tier drops to 20 leaf-health checks,
1 identification and 25% of the chat budget; paid caps are unchanged.
Implementation is on `feat/tier-aware-ai-caps`._

**F2 — 200 is simultaneously too generous for Seedling and too tight for
Greenhouse.** The cap is per _household_, and Greenhouse allows 50 members:
200 ÷ 50 = **4 checks per person per month** on the top tier. Raising it is
justified there; it should be raised deliberately, alongside F1, not quietly.

**F3 — Garden Lifetime has no cost horizon.** Every other plan re-prices
against its COGS on a cadence; lifetime never does. Either bound its AI
allowances explicitly, price it against a modelled lifespan, or retire it.

_Decided 2026-09-02 (ADR 0012): retired from sale, together with both annual
plans, which §4 shows are underwater at ceiling at the verified price.
Existing holders keep what they bought. Implementation is on
`feat/withdraw-annual-and-lifetime`._

**F4 — No prompt caching anywhere.** `grep -r cache_control backend/src` returns
nothing outside a CORS header. Leaf-health's ~250-token system prompt is below
Haiku 4.5's minimum cacheable prefix, so there is nothing to win there — but the
chat path (system prompt + 5 tool definitions + up to 24 history messages + RAG
spans) plausibly clears the threshold, and input is half the chat budget. Worth
_measuring_ `usage.cache_read_input_tokens` before assuming a win.

**F5 — The cost constants have never been checked against an invoice.**
`bedrock.ts` prices at $1/$5 per MTok with no allowance for the `us.`
cross-region premium. If the premium applies, logged `costUsd` — and the dollar
value of the chat budget — are ~10% low. One invoice line settles it. **Do not
change the constant on the strength of this estimate.**

**F6 — Fixed in this PR: `leafHealthBudget.getUsage` collapsed "no spend" and
"failed read" into the same `0`.** This is the same defect already fixed in the
sibling `identifyBudget.getUsage`, never back-ported. Nothing in `src/` calls
it today — the live gate is the fail-_closed_ `reserveUsage` — so it was a
latent trap rather than a live bug: a future caller wiring `isOverCap` in as
the spend gate would have inherited a guard that silently reports "under cap"
on every DynamoDB hiccup. `getUsage` now returns `number | null`, and
`isOverCap`'s fail-open decision is made and logged at the call site.
**Behaviour is unchanged.**

---

## Verifying this for free

Nothing below costs anything or requires a model call:

1. **Real leaf-health token counts.** `leafHealth.ts` already logs
   `inputTokens` / `outputTokens` on every success under
   `leaf_health_assessed`. A CloudWatch Insights query over a week of that
   event replaces the "typical" row with a measured distribution.
2. **Real chat cost.** `bedrock.ts` logs `costUsd` per call. Sum it by month
   and compare against the Bedrock line on the AWS bill — the gap is the
   answer to F5.
3. **Actual cap utilisation.** The `LEAFHEALTH#BUDGET` and `IDENTIFY#BUDGET`
   partitions hold one row per household per month. Scanning a month tells you
   what fraction of households approach the caps at all — which converts every
   "ceiling" figure above into an expected value. If nobody reaches 200,
   F1's urgency drops sharply; if the top decile does, it rises.
4. **Plant.id's price** — done 2026-09-02 from the public pricing page (§2).
   What only an invoice can add: the card-conversion spread that the 1.17
   assumption stands in for, and whether a failed call is charged.
5. **Real identification spend.** `handlers/plants/identify.ts` now logs
   `costUsd` on every configured call under `plant_id_identify`. Sum it by
   month exactly as for `bedrock_invoke` and compare with the Kindwise credit
   balance — the gap is the answer to the two questions above.

Steps 1–3 and 5 are the difference between this document and a real cost
model. It is deliberately built from committed constants so it can be checked,
not trusted.
