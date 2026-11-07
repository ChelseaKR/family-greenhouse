# 0040 — The free plan is cut to 8 plants and 2 people, and households created before the cut keep 20 and 3

**Status:** Accepted

**Date:** 2026-10-23

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0014](0014-plans-drawn-on-homes-and-hands.md) (the re-cut that set Seedling at
20 plants and 3 members; this ADR changes those two numbers and nothing else in it),
[ADR 0027](0027-no-card-garden-trial.md) (the no-card trial, which ends on Seedling),
[ADR 0039](0039-trial-lifecycle-emails.md) (the day-10 and day-14 emails that name the free caps),
`backend/src/models/plans.ts` (the catalog and the grandfathering rule, in code).

## Context

ADR 0014 set Seedling at 20 plants and 3 members, on purpose generous: plant rows cost nothing,
and the plan was to buy member #2 with that generosity and charge at the fourth hand.

The first real measurement, on 2026-10-23, said those caps were limits nobody met. Of 43
households, 3 belong to people outside the owner's own household. They hold 5, 6 and 9 plants,
with 1 or 2 people each. None of them came near 20 plants or 3 people, so none of them had a
reason to look at Garden, and Stripe has never taken a charge.

The owner decided to cut Seedling to **8 plants and 2 people**. Garden ($4.99) and Greenhouse
($9.99) do not change. Two people still lets a couple share a home at $0, so Seedling is still
"a couple and their plants"; the charge lands at the third hand and the ninth plant.

One of the three outside households has 9 plants, which is over the new cap. It signed up under
"free for up to 3 people and 20 plants", and so did everyone else who signed up before the cut.

## Decision

1. **The catalog caps are 8 plants and 2 members.** `PLANS.seedling.limits` in `plans.ts`. Every
   public statement of the free limits follows it, in English and Spanish, and the gates that
   re-derive those statements (`check-plan-copy.mjs`, `check-doc-figures.mjs`,
   `check-brand-assets.mjs`, `helpFigures.test.ts`) enforce that.

2. **A household created before `SEEDLING_LIMITS_CUT_AT` (2026-10-24 00:00 Pacific) keeps 20
   plants and 3 members** for as long as it is on Seedling: never paid, a no-card trial that
   ended, or a cancelled subscription. Paid tiers are untouched by this rule.

3. **The rule is a read-time comparison with the household row's own `createdAt`.** It is applied
   by `withSeedlingGrandfather`, last, inside both entitlement resolvers (`getEntitledPlan` and
   `getEntitledPlanForIssuedGrant`), so every cap gate, the usage meters in GET /billing/me, the
   billing emails and the trial emails see the same caps without any of them knowing the rule
   exists. `billing.getHouseholdSubscription`, which every cap gate already reads, carries
   `createdAt` through as `householdCreatedAt`.

4. **Caps still limit new growth only.** As before (ADR 0014), a household above its cap keeps
   everything, can read, edit, archive and remove anything, and is refused only the next add. A
   household that is over 8 plants without being grandfathered can therefore only exist by
   downgrading from a paid plan, and it keeps everything too.

5. **At the cap, the app says so before the form, with the way forward.** The Add Plant page and
   the invite section of the Household page show the existing locked-feature card when the
   household's enforced cap (from the usage block, never the catalog) is reached: the count and
   the cap, that nothing is removed, the free way to make room, and the plan that lifts the cap
   with its catalog price. An admin's button goes to the existing checkout in Settings → Billing;
   a member gets the existing one-tap ask. The native apps show no price and no purchase call
   (Guideline 3.1.1), as they already do for every locked feature.

## Why `createdAt` and not a stored flag

A stored `limitsGrandfatheredAt` attribute would have to be written onto every existing
production household before the new caps took effect, which is a data migration with a window
in which a real household could be held to 8. `createdAt` is already on every row
`createHousehold` writes, it never changes, and comparing it on read has no window, no job, and
nothing to backfill. It is the same shape as the no-card trial's end date.

A row that exists but has no readable `createdAt` is treated as created before the cut
(`HOUSEHOLD_CREATED_AT_UNKNOWN`). Getting that wrong costs a dozen plant rows that cost nothing to
serve; getting it wrong the other way breaks a limit a real household was promised.

## Consequences

- The cutoff must be at or before the deploy that ships this. A household created between the
  cutoff and that deploy was shown "20 plants" but would be held to 8 for new growth (it keeps
  everything it adds). Moving the cutoff later, up to the deploy day, is safe. It must also stay
  in the past: a unit test refuses a future cutoff, because one would grandfather every household
  a test creates today and turn the suite red on the day it passed.
- The Terms and the help pages name the date, so moving the cutoff means moving those sentences
  too. A unit test ties them to `SEEDLING_LIMITS_CUT_AT`.
- The catalog (`GET /billing/plans`) states 8 and 2, which is what a new household gets. A
  grandfathered household's meters show 20 and 3, and Settings → Billing says why.
- The Terms change, so their effective date moves with the release that ships this
  (`check-terms-effective-date.mjs`).
