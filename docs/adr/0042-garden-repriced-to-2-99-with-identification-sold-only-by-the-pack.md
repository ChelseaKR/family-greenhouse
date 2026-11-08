# 0042 — Garden is repriced to $2.99 a month or $24.99 a year, and plant identification leaves the plan

**Status:** Accepted

**Date:** 2026-11-07

**Deciders:** Chelsea Kelly-Reif (option B, 2026-11-07)

**Related:** [ADR 0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md) (the per-call
cost and why annual was withdrawn), [ADR 0019](0019-identification-top-up-packs.md) (the
$1.99 pack this decision makes the only way to buy identification),
[ADR 0027](0027-no-card-garden-trial.md) and [ADR 0039](0039-trial-lifecycle-emails.md) (trials,
unchanged), [ADR 0040](0040-seedling-cut-to-8-plants-and-2-people-with-grandfathering.md) (the
grandfathering pattern this follows), [ADR 0041](0041-apple-in-app-purchase-in-the-iphone-app.md)
(the App Store wiring this extends), `evals/UNIT-ECONOMICS.md`, `backend/src/models/plans.ts`.

## Context

ADR 0012 measured Garden's AI-cost ceiling at $3.49 a month on a $4.99 plan: $1.73 of
leaf-health and chat, and 30 identifications at $0.0585, which is $1.76. Identification is the one
line with a hard per-call vendor cost, and it was more than half the ceiling. A simple price cut
loses money. Moving identification to the pack (ADR 0019) removes that line from the plan: a
household that wants identifications buys them at $1.99 for 20, which ADR 0019 measured at a
positive margin.

## Decision

1. **Garden is $2.99 a month or $24.99 a year.** The yearly price is about 30% under twelve
   monthlies ($35.88). Greenhouse is unchanged ($9.99 a month, yearly still withdrawn). Garden
   lifetime stays withdrawn.
2. **Plant identification is not part of Garden.** `IDENTIFY_ALLOWANCES.garden` is 0. A pack works
   on any plan, because `reserveIdentification` draws a credit whenever the plan allowance is
   refused, and an allowance of 0 is refused at once. The pack is bought by a household admin on
   the website (it is not sold in the iPhone app, Guideline 3.1.1). Seedling keeps 1 a month and
   Greenhouse keeps 100.
3. **Leaf-health for Garden drops from 200 to 100 a month** (`leaf_health_monthly_cap_garden =
"100"` in the production tfvars). This departs from "keep as is", because the recomputed table
   below shows 200 does not survive the yearly price through Apple (98% of net revenue). Chat is
   unchanged. Greenhouse is unchanged at 200.
4. **Existing subscribers keep their price.** Stripe prices are immutable and a running
   subscription holds its own price object, so the $4.99 and $39.99 prices stay live and are never
   archived. The catalog lists them as `legacyPrices` on Garden: the webhook's `planIdFromPriceId`
   still maps them to Garden, `reconcileConfiguredPrices` still checks each at its own amount,
   and checkout never sells them. Their env vars keep their names, so no tfvars value moves.
5. **The new prices have their own Terraform variables, blank by default**:
   `stripe_price_id_garden_299` and `stripe_price_id_garden_annual_2499` (the amount is in the
   name because a Stripe price's amount can never change). Two guards:
   - `GET /billing/plans` publishes a cadence whose current id is blank as `null`, the same "not
     available" a withdrawn cadence sends, so the site never advertises an amount checkout would
     refuse.
   - A `commercial_gate_guard` precondition refuses a plan where exactly one of the pair is set.
     Both blank means Garden is off sale in that environment; both set means it is on sale. This
     holds whether or not payments are enabled, because the mistake is in the tfvars.
     The old "Garden monthly id must be non-empty" requirement moves to the pair rule.
6. **Trials are unchanged.** A household gets the no-card 14 days, and a checkout during them
   charges on the day they end (no stacked trials, `trial_end` set to the no-card end). The
   trial's metering is Seedling's, so identification during a trial was never Garden's.
7. **iPhone.** Garden gets a monthly product (`garden.monthly`, repriced) and a new yearly product
   (`garden.yearly`) in the same subscription group and at the same level, so a switch between
   them is a crossgrade Apple applies at the next renewal. `POST /billing/app-store/purchase-intent`
   takes an optional `interval` (`month` default, `year`). The three deployment switches from
   ADR 0041 are untouched.
8. **Gifts follow the monthly price** (ADR 0028), so a Garden gift month becomes $2.99. The gift
   Stripe price is reconciled against the catalog, so a $4.99 gift price in Stripe is refused at
   checkout until the owner creates a $2.99 one (step 7 below). Production has no gift ids set
   today, so nothing is on sale that would break.
9. **The "ask your admin" upsell for identifications points at Greenhouse**, the only tier whose
   price includes an allowance, not at Garden.

## The margin, recomputed

AI cost per household per month at the ceiling, from `evals/UNIT-ECONOMICS.md` §2 and §4:
leaf-health $0.0059 a check at the ceiling, chat $0.55, identification $0.0585 each.
Stripe is 2.9% plus $0.30 per charge, taken once a year on yearly plans. Apple is 15%
(Small Business Program).

| Garden plan                              | Revenue / mo | AI ceiling | % gross | % net of Stripe | % net of Apple | Left / mo (Stripe) | Left / mo (Apple) |
| ---------------------------------------- | -----------: | ---------: | ------: | --------------: | -------------: | -----------------: | ----------------: |
| Before: $4.99 monthly, 200 checks, 30 id |        $4.99 |      $3.49 |     70% |             77% |            82% |              $1.06 |             $0.76 |
| $2.99 monthly, 200 checks, 0 id          |        $2.99 |      $1.73 |     58% |             66% |            68% |              $0.87 |             $0.81 |
| **$2.99 monthly, 100 checks, 0 id**      |    **$2.99** |  **$1.14** | **38%** |         **44%** |        **45%** |          **$1.46** |         **$1.40** |
| $24.99 yearly, 200 checks, 0 id          |        $2.08 |      $1.73 |     83% |             87% |            98% |              $0.27 |             $0.04 |
| **$24.99 yearly, 100 checks, 0 id**      |    **$2.08** |  **$1.14** | **55%** |         **57%** |        **64%** |          **$0.86** |         **$0.63** |

Reading it: moving identification out takes the monthly plan's ceiling from 70% to 58% of
revenue with leaf-health left alone. The yearly price at 200 checks keeps $0.04 a month through
Apple, which is no margin for the AWS baseline, so the cap goes to 100. At 100 every row keeps at
least $0.63 a month at the ceiling. These are ceilings; most households will not reach them
(`evals/UNIT-ECONOMICS.md` §"Verifying this for free" says how to measure actual use). Two things
only an invoice settles, unchanged from ADR 0012: the card-conversion spread behind the $0.0585,
and whether Bedrock's `us.` routing premium applies (the leaf-health figure already includes it).

A household that does want identifications pays for them: a pack is $1.99 for 20, $0.46 of margin
through Stripe (ADR 0019).

## Yearly first (added 2026-11-08)

The yearly price is the one a household sees first. The cadence toggle on the pricing page and on
Settings → Plan status opens on Yearly, showing $24.99 with the saving derived from the amounts
("Save ~30%"). Monthly is one tap away, and the tap is kept in memory for the page load only:
nothing is written to storage and nothing is sent anywhere. Greenhouse sells no yearly cadence, so
on the Yearly tab its card reads "Not available at this interval", as it did whenever a person
tapped Yearly before. The iPhone app lists products rather than toggling, so its yearly row comes
first. The day-10 and day-14 trial emails (ADR 0039 §7, amended) name the yearly price first and
then the monthly, each once: "If you would like to keep Garden, it is $24.99 a year, or $2.99 a
month." Both amounts are read from the catalog, and a catalog with no yearly Garden price on sale
names the monthly alone.

Why: every paid rival read on 2026-11-08 (Planta, Greg, PictureThis, Blossom, Gardenia) leads with
a yearly price between $29.99 and $79.99, and $24.99 is the lowest yearly price in that set. A
yearly charge hands Stripe $1.02 of $24.99, about 4%, where twelve monthly charges hand it $4.68 of
$35.88, about 13%; the margin table above already holds at the yearly price. Risk: RevenueCat's
2026 report puts year-one cancellation of annual subscribers at 72%, a third of it in month one,
so refund requests are expected; docs/billing.md has the refunds section.

Kill rule: if fewer than 3 of the first 10 real checkouts (owner and test households excluded, as
the money check excludes them) choose yearly, the default reverts to monthly. Nothing else in this
ADR changes with it.

## Owner steps

**Stripe Dashboard, live mode** (repeat in test mode for staging). Do this before any tfvars change.

1. Products, open the existing **Garden** product. Do not create a new product, and do not edit or
   archive the existing $4.99 and $39.99 prices.
2. Add price: Standard pricing, Recurring, **$2.99 USD, monthly**. Under Additional options, add
   metadata `plan_id` = `garden`, `interval` = `month`, `adr` = `0042`. Save, copy the `price_` id.
3. Add price: Recurring, **$24.99 USD, yearly**, metadata `plan_id` = `garden`,
   `interval` = `year`, `adr` = `0042`. Save, copy the id.
4. Gifts: add a **one-time** price on the Garden product for **$2.99 USD** (one gift month) and,
   only when gifts go on sale, paste it as `stripe_price_id_gift_garden_month`.
5. Settings, Customer portal: under "Customers can switch plans", list the Garden $2.99 monthly,
   the Garden $24.99 yearly and the Greenhouse monthly. Leave the $4.99 and $39.99 Garden prices
   and the other withdrawn prices off the list. Existing subscribers stay on theirs.
6. In `infrastructure/environments/production/terraform.tfvars`, in one change: paste both ids
   into `stripe_price_id_garden_299` and `stripe_price_id_garden_annual_2499`, and add both to
   `stripe_price_ids_attested` with comments. The plan fails if only one is set or if either is
   unattested.
7. Before the apply, email nobody: no running subscription is moved, so no 14-day notice is owed
   (docs/billing.md, "Price changes"). New buyers see the new price on the day the ids land.

**App Store Connect** (iPhone, when ADR 0041's switches are on):

1. Subscriptions, group "Family Greenhouse plans", `net.familygreenhouse.app.garden.monthly`:
   set the price to the **$2.99 USD** price point (the old Tier 3). Apple applies a price decrease
   to existing subscribers automatically, so there is nothing to preserve; nobody is subscribed
   through Apple yet.
2. Create `net.familygreenhouse.app.garden.yearly`: 1 year, same group, **same level as
   Garden monthly**, **$24.99 USD** price point (the old Tier 25), no introductory offer, not
   Family Sharing, display name "Garden (yearly)". Confirm both points in the price picker.
3. Product ids can never be reused once created. The listing text does not mention identification.

## Alternatives considered

**A plain price cut to $2.99, identification kept at 30 a month.** Rejected: $3.49 of ceiling
on $2.99 of revenue is a loss before Stripe, and 105%-style annual maths returns.

**Keep leaf-health at 200.** Rejected for the yearly price through Apple (98%).

**Rename the existing price slots instead of adding new variables.** Rejected: the Terms promise a
subscriber the price they bought, and re-pasting a new id into the slot the webhook maps renewals
through would orphan every renewing $4.99 household.

**Move existing $4.99 subscribers to $2.99.** Not done. It would be a plain gift of margin and a
migration of live subscriptions; they can switch themselves in the portal.

## Consequences

- Garden sells at $2.99 and $24.99 only after the owner sets both ids; until then the pricing page
  says Garden is not available at those cadences and nothing is charged at an old or invented price.
- The identification allowance change applies to every Garden household, including any that
  subscribed at $4.99: the Terms promise a subscriber their price, not an allowance, but they did
  see "30 a month". The money check of 2026-10-23 found Stripe had taken no charge, so this
  should affect nobody; check the Stripe subscription count before the apply, and if a paying
  household exists, either tell them first or leave their allowance for one cycle. The Terms and
  help say it plainly: "Identification is sold as a 20-identification pack for $1.99; it is not
  included in Garden."
- The Terms change, so their effective date moves with the release that ships this
  (`check-terms-effective-date.mjs`).
- The yearly toggle returns to the pricing page, with a saving derived from the amounts (30%).
- The pack is not offered in the iPhone app, so an iPhone-only Garden household that wants
  identification does it on the website.
