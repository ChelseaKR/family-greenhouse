# B2B greenhouse mode — design sketch (pilot-gated)

> **Status: design only. No code until a real nursery pilot is signed.**
> This is the Year-3 "B2B" roadmap theme worked out far enough that we can
> evaluate a pilot conversation honestly — what we'd build, what we already
> have, and what we refuse to build. If no nursery wants this badly enough
> to pilot it with us, the document stays a document. (See the roadmap
> principle: _default no_.)

## The pitch, restated

A greenhouse or nursery sells a plant. Today the buyer walks out with a care
tag printed in 6-point type. In greenhouse mode, the plant ships with a
**pre-filled care plan** that imports into the buyer's Family Greenhouse
household in one tap — and the nursery gets a lightweight back-office for
managing its own stock's care across staff.

Two distinct value streams, in priority order:

1. **Customer-facing care cards** (the wedge): every plant sold carries a QR
   link to a care-card snapshot — species, suggested schedule, the nursery's
   own notes — that imports as a plant + tasks. This is marketing the nursery
   pays for and a customer-acquisition channel for us.
2. **Staff-facing care operations** (the expansion): the nursery's own
   benches, watering rotations, and seasonal schedules, run by staff on the
   same task engine households use.

## What a nursery needs beyond a Greenhouse-tier household

A Greenhouse-tier household already gives: high plant caps, many members,
templates, analytics, the public API. The deltas:

| Need                                         | Why a household isn't enough                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Staff roles, not family roles**            | Households have `admin`/`member` — peers who trust each other. A nursery needs at least `owner` / `manager` / `staff` (and possibly `seasonal` with an expiry), where staff can complete tasks but not edit billing, delete plants, or see revenue-ish analytics. Role checks today are a single `requireAdmin` gate; B2B needs a small permission matrix.                             |
| **Care-plan templates at the species level** | `models/taskTemplates.ts` is the seed: 6 curated bundles applied per plant. A nursery needs **its own** template library keyed by species ("our Monstera deliciosa schedule"), versioned, applied to hundreds of plants at once and stamped onto every care card for that SKU. The `apply-template-bulk` route is the mechanical precedent.                                            |
| **Customer-facing care cards**               | The cutting-share pattern (`createPlantShare`: frozen snapshot + code + public no-auth preview + accept-into-household) is exactly the right shape. Deltas: cards are minted per **SKU/batch**, not per plant; they don't expire in 14 days; they carry a task template, not just notes; and accepts need attribution ("imported from Bloom & Vine") for the nursery's funnel metrics. |
| **Volume pricing**                           | Per-household subscription pricing makes no sense at 5,000 plants and 12 staff. Pricing axis shifts to seats + active care cards/month. Stripe per-seat licensed pricing covers it; the plan catalog (`models/plans.ts`) needs a `business` tier family that is **not** visible on the consumer pricing page.                                                                          |
| **Locations / benches**                      | A household has one implicit location plus a free-text `location` field per plant. A nursery has greenhouses → benches → flats. The free-text field probably stretches surprisingly far for a pilot (filterable tags already exist); first-class locations are a post-pilot decision.                                                                                                  |
| **Bulk everything**                          | 100-row import cap, per-plant photo flows, and single-plant task creation all assume tens of plants. Nursery onboarding means thousands of rows — batch endpoints and a CSV pipeline that doesn't sweat.                                                                                                                                                                               |

## What maps over (the reuse story)

The honest reason this theme is plausible at all: most primitives exist.

- **Households → business accounts.** Multi-household-per-user already works
  (`X-Household-Id` pinning), so "staff member who also has a family
  greenhouse at home" is free. A business account is a household with a
  `kind: 'business'` flag, a different plan family, and the staff role
  matrix.
- **Members → staff.** Same membership rows, same invite flow; the delta is
  the role enum and gates.
- **Task engine, unchanged.** Tasks, claiming, vacation-mode handoff, snooze,
  streaks, climate-skip — a watering rotation across benches is the family
  task list at higher volume. Task _claiming_ (built for families) is
  accidentally the staff-shift primitive.
- **taskTemplates → species care plans.** The curated-bundle model becomes
  tenant-authored, species-keyed rows; `apply-template-bulk` becomes
  "apply to every plant with species X".
- **Share-snapshot pattern → care cards.** Snapshot-on-mint (immune to later
  edits), public preview route, accept-with-plan-caps: all proven by cutting
  shares. Care cards generalize the snapshot to include a task template.
- **Public API + write scopes.** The `fg_` key auth, per-key scopes
  (read + the new write scopes), and rate limiting give a nursery's POS or
  inventory system an integration surface on day one — printing QR codes at
  the register is an API client, not a new product.
- **Import/export.** CSV/JSON import (with per-plant tasks) is the bulk
  onboarding backbone; it needs a bigger batch ceiling, not a redesign.

## Open questions

- **Tenancy boundary.** Is a business account literally a household row with
  a flag, or a new entity that _owns_ households (one per greenhouse
  location)? The flag is dramatically cheaper; the entity is cleaner if
  multi-location chains show up. Decide from pilot shape, not speculation.
- **Care-card → customer linkage.** When a buyer imports a care card, does
  the nursery see anything (aggregate counts only? opt-in survival stats?)?
  Privacy posture must be decided before the first card is printed —
  households are private spaces and we will not leak care behavior to
  vendors by default.
- **Who owns the species care plan after import?** If the nursery updates
  their Monstera plan, do past buyers see the update (subscription-ish) or
  is the import a frozen copy (snapshot-ish)? Snapshot is consistent with
  everything else we ship; subscription is a support burden and a privacy
  question.
- **Survival-rate claims.** Nurseries will want "plants sold with our care
  cards survive N% longer" marketing. Our North-star metric tempts us here;
  _honesty in marketing_ (roadmap principle) means we only surface this with
  real, methodologically defensible data.
- **Seasonal staff churn.** Invite/remove flows are fine at family scale;
  is a `seasonal` role with auto-expiry needed at pilot scale, or is manual
  removal fine for a 12-person nursery?
- **Pricing floor.** What does this cost at 1,000 households… er, at 50
  nurseries? Bedrock/Perenual/Plant.id per-call costs are all metered per
  household today; business accounts need their own budget envelopes.

## Pilot success criteria

A pilot is one real nursery, one season (≈ 3 months), hand-held onboarding.
It succeeds if:

1. **Cards get scanned and imported.** ≥ 20% of plants sold with a QR care
   card are imported into a (new or existing) household within 14 days of
   sale. Below that, the wedge isn't a wedge.
2. **Imported plants get cared for.** Imported-plant task completion within
   24h of due ≥ the consumer baseline (75%) — the care plan has to actually
   drive care, or it's a gimmick.
3. **Staff actually run their day in it.** ≥ 60% of the nursery's own care
   tasks completed in-app by week 6 (not re-entered from a paper schedule).
4. **The nursery would pay.** A signed LOI or renewal at a real (volume)
   price point, not a free-pilot extension.
5. **We didn't fork the product.** The pilot ran on flags + the deltas above
   — if it needed a parallel codebase, the reuse story was wrong and the
   theme should be re-evaluated.

## Non-goals (explicit)

- **No marketplace.** We do not broker plant sales, take payment for plants,
  or build storefronts. The nursery sells; we ship the care plan.
- **No inventory management.** Stock counts, pricing, POS — that's their
  existing software; we integrate via the public API at most.
- **No white-label app.** Care cards carry the nursery's name inside _our_
  product. A rebrandable shell is a different (worse) business.
- **No consumer-side changes gated on B2B.** Families never see business
  features, business pricing, or vendor branding outside an imported card.
- **No diagnostic claims.** Same line we hold on leaf-health: cosmetic-grade
  observations only, for staff and customers alike — never "your plant has
  root rot," and never plant-health guarantees to buyers.
- **No build-ahead.** No schema fields, no dormant flags, no "while we're in
  there" — nothing lands in the codebase until the pilot is signed (this
  document is the only artifact).
