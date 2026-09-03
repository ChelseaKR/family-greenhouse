# AI unit economics — what each call costs, and whether a paying customer pays for it

**Written 2026-09-02, against `origin/main` @ `cd149db`.** Paid plans went live
2026-09-01 (`commercial-status.json`), so every AI call now has a margin
consequence as well as a quality one. `evals/README.md` covers the quality
half; this file covers the cost half.

**No live model calls were made to produce this.** Every figure below derives
from constants committed in this repository plus published per-token list
prices. Where a number is not in the repo — notably the Plant.id per-call
price — it is left as a variable rather than guessed. See
[Verifying this for free](#verifying-this-for-free) for how to replace the
estimates with measurements without spending anything.

---

## 1. What ships, and on what

| Feature              | Route                            | Provider / model                                                    | Cost shape                                                                                                      |
| -------------------- | -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Plant identification | `POST /plants/identify`          | **Plant.id** (third party)                                          | Metered per-call credit                                                                                         |
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

Plant.id bills a per-call credit. **That price is not recorded anywhere in this
repository** — `docs/deployment.md` says only "Plant.id costs are
vendor-dependent". It is therefore carried below as `P`.

This is the single largest unknown in the whole model, and as §4 shows, it is
the variable that decides whether the annual plans are healthy or not. It
should be written down.

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
using the 1.10× rates and the leaf-health _ceiling_:

```
leaf-health   200 × $0.0059  = $1.18
chat          at budget       = $0.55
identify      allowance × P
                              ─────────────────
Seedling (free)   $1.73 +   3P
Garden            $1.73 +  30P
Greenhouse        $1.73 + 100P
```

Against price, with Stripe (2.9% + $0.30) taken out separately:

| Plan                              | Effective $/mo | AI COGS @ P=$0.02 | % of revenue | AI COGS @ P=$0.04 | % of revenue |
| --------------------------------- | -------------- | ----------------- | ------------ | ----------------- | ------------ |
| **Seedling (free)**               | $0.00          | $1.79             | **∞**        | $1.85             | **∞**        |
| Garden monthly                    | $4.99          | $2.33             | 47%          | $2.93             | 59%          |
| **Garden annual** ($39.99/yr)     | $3.33          | $2.33             | **70%**      | $2.93             | **88%**      |
| Greenhouse monthly                | $9.99          | $3.73             | 37%          | $5.73             | 57%          |
| **Greenhouse annual** ($79.99/yr) | $6.67          | $3.73             | **56%**      | $5.73             | **86%**      |

### Can a paying customer cost more than they pay?

**In a single month, on a monthly plan: no.** A maxed-out Garden monthly
subscriber costs about $2.33 against $4.99. There is no month in which they go
negative.

**On Garden Lifetime ($149): yes, with certainty.** $149 net of Stripe is
$144.38. At $2.33/month of AI COGS that is **62 months — about 5.2 years — to
burn the entire payment on AI alone**, and every month after that is pure loss.
At P=$0.04 it is 4.1 years. That is before a cent of AWS baseline (Lambda,
DynamoDB, API Gateway, CloudFront, Cognito) or support. Lifetime is the only
plan with no mechanism to re-price against its own cost, and the AI allowances
it inherits do not expire.

**The sharper problem is the annual plans, which the plan catalog itself says
the business monetizes on** ("the category monetizes primarily on annual plans"
— `models/plans.ts`). Garden annual at 70% AI-COGS-of-revenue leaves roughly
**25% gross margin** after Stripe, before any infrastructure. No individual
month is negative, but a subscription business running at 25% gross margin has
a structural problem, not a cost-optimisation opportunity. The category
benchmark is 70–80%.

**And the free tier is the largest unpriced exposure.** A Seedling household —
$0 revenue — has the *same* 200 leaf-health checks and the *same* 250k/50k chat
budget as a $9.99 Greenhouse household, and can spend up to **$1.79/month**.
Free households are the most numerous ones.

### The number that decides it

Everything above swings on `P`, and `P` is not written down. At $0.02 the
annual plans are strained; at $0.04 they are close to underwater. **Find the
Plant.id per-call price, put it in `docs/deployment.md`, and re-run this
table.** That is the highest-value hour available here.

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

**F2 — 200 is simultaneously too generous for Seedling and too tight for
Greenhouse.** The cap is per _household_, and Greenhouse allows 50 members:
200 ÷ 50 = **4 checks per person per month** on the top tier. Raising it is
justified there; it should be raised deliberately, alongside F1, not quietly.

**F3 — Garden Lifetime has no cost horizon.** Every other plan re-prices
against its COGS on a cadence; lifetime never does. Either bound its AI
allowances explicitly, price it against a modelled lifespan, or retire it.

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
4. **Plant.id's price.** From the vendor dashboard. Then re-run §4.

Steps 1–3 are the difference between this document and a real cost model. It is
deliberately built from committed constants so it can be checked, not trusted.
