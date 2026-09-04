# 0014 — The plan line is drawn on homes and hands, not on collection size

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md)
(the per-identification cost that withdrew annual and lifetime), `backend/src/models/plans.ts`
(the catalog, in code), `backend/src/services/homesGate.ts` (the one per-user cap),
`docs/multi-household.md` (what "a home" is).

## Context

Paid plans went live on 2026-09-01. Two days later the paid-feature ideation
brief grepped every plan check in `backend/src` and found five gates: a plant
cap, a member cap, and three metered AI allowances (identification,
leaf-health, chat), plus API keys on the top tier. Everything that makes the
product a _shared household_ app rather than another plant tracker — invites,
roles, vacation cover, sitter links, task claiming, the activity feed,
per-member analytics, multi-household switching, export, `.ics` — was free.

Two things fell out of that table.

1. **The member cap was 6 on both the free tier and Garden.** A household of
   six coordinating plant care paid nothing. The pricing page said it out
   loud: _"Paid plans lift those caps."_ That is a storage-quota pitch for a
   coordination product.
2. **Of the four things Garden added, three were metered inference.** A Garden
   household that used what the tier said it could use cost more in AI calls
   than it paid (ADR 0012 put the ceiling at 70% of revenue before
   infrastructure). The tier's only reasons to buy were the reasons it lost
   money.

The closest validated analogue is in the adjacent category. Tody (chores) is
free forever and complete _for one person_; multiple homes is one paid gate;
the multi-user layer is the product sold on top. That is the same structure
and the same buyer.

## Decision

**The line moves from collection size to homes and hands.** Three tiers,
same names, same monthly prices, re-cut:

|                                            | Seedling (free)           | Garden $4.99                       | Greenhouse $9.99       |
| ------------------------------------------ | ------------------------- | ---------------------------------- | ---------------------- |
| Story                                      | A couple and their plants | A household that has to coordinate | Many homes, many hands |
| Homes per user                             | 1                         | 1                                  | unlimited              |
| Members per home                           | 3                         | unlimited                          | unlimited              |
| Plants per home                            | 20 (was 10)               | 200 (was 500)                      | 5,000                  |
| Plant Tags                                 | —                         | 50                                 | unlimited              |
| Analytics window                           | 30 days                   | full history                       | full history           |
| Sitter link                                | 1 active, ≤ 7 days        | Away Kit (to 90 days)              | Away Kit               |
| Toolkit / Move Day                         | —                         | on                                 | on                     |
| Cross-home Today / kiosk / caretaker seats | —                         | —                                  | on                     |
| Chat                                       | —                         | on                                 | on                     |
| API keys                                   | —                         | —                                  | on                     |

Identification and leaf-health allowances are not in this table because they
are not in the catalog: they are metered upstream-cost budgets owned by
`identifyBudget.ts` and `leafHealthBudget.ts` (free: 1 identification, 20 leaf
checks; Garden 30 / 200; Greenhouse 100 / 200). The catalog carries structural
caps — things that cost nothing to serve.

One of those numbers moves here. ADR 0012's decision 2 dropped the free tier
to **1 identification**, and only the leaf-health and chat halves of it landed
(#396, #407 — both per-environment); `IDENTIFY_ALLOWANCES.seedling` was still 3. It is 1 as of this change. That is the single largest line in the free
tier's AI ceiling at the verified $0.0585 per call, and this re-cut is what
makes it defensible: the free tier's reason to exist is now a complete
coordination product for a couple, not an inference allowance.

Four consequences of the shape are load-bearing.

**Free keeps member #2 free, and charges at the fourth hand.** Every instinct
says charge for the second seat; Tody does exactly that with its Duo tier.
Not here: the north star is ≥ 1.5 active members per household and
`docs/strategy-review.md` lists "households of 2–4 will install a shared app
for plant care" as an untested assumption. Tody sells seats from proven
adoption; this product is still proving it. Charging at member #2 taxes the
activation event most needed. Free is three hands; Garden is as many as the
house has, and is sold on what a coordinating household then _needs_ — the
toolkit — not on the seat.

**Unlimited is `null`, and one accessor interprets it.** `Limit = number |
null`; `null` is documented as unlimited. Never `Infinity`: the catalog is
published to the client as JSON, and `JSON.stringify(Infinity)` is `null`
anyway — this makes that the typed, deliberate representation rather than an
accident. Every cap gate reads `limitOf(plan, key)` and compares with
`atCap(current, limit)`; every feature gate reads `hasFeature(plan, key)`.
The cap and feature maps are published in `planSummary` (`limits`,
`features`) so the client gates without a second call, and their key names
are a contract other domains read by name.

**Caps limit new growth only — the grandfather rule.** `atCap` answers "may
one more be added?" and is deliberately `>=`, so a household already above a
cap is at cap too: the next add is refused and _nothing else changes_. A free
household with four members from before this decision keeps four. A Garden
household with 300 plants keeps 300. A user who belongs to five households
keeps five, reads and acts in every one, and is only told no on the sixth.
Nothing is reduced, deleted, or hidden; the tests in
`backend/tests/unit/handlers/households.test.ts` and
`backend/tests/unit/models/plans.test.ts` prove an over-cap household can
still read everything and is only blocked on the next add. This is also what
the Terms already promise ("nothing is deleted when a plan changes").

**Homes are a per-user cap resolved against the strongest plan the user
would hold.** Plans belong to households; people belong to several. The
homes cap is therefore evaluated against the highest plan among every
household the person is in _plus the one they are joining_
(`services/homesGate.ts`). A Greenhouse household never turns a hand away,
and a Greenhouse member may help at any number of homes; a Seedling or
Garden user has one home. Grandfathering applies here too.

### Export and history stay free

Not one of nine plant apps surveyed monetises data portability, so there is
no competitive money on that table — and gating survival history in a
product whose headline metric is plant survival means hiding the data from
the people trying to improve it. So: `GET /me/export`, the `.ics` feed, the
per-plant history, and the year-in-review recap email stay on every tier.
Free's 30-day _analytics_ window narrows only what `GET
/households/{id}/analytics/daily` and `GET /households/{id}/year-in-review`
will render on request; the completion records behind them are never
trimmed, and the response says which window applied (`historyLimitDays`) so
the client can say why and where to go.

## Open questions for the owner (not decided here)

Prices are unchanged in code and Stripe prices are untouched. Two questions
the brief raised are owner decisions and are recorded so they are not
relearned:

1. **Greenhouse at $9.99 serves neither customer.** Verified category annuals
   are Greg $29.99, PictureThis $39.99 (Family $49.99), Planta $47.99, Blossom
   $59.99. With annual withdrawn, Garden is $59.88/yr (top of the band) and
   Greenhouse is $119.88/yr, 2.5–4× every consumer competitor. As a consumer
   tier that is unsellable; as a business tier — against pet-sitting at
   $27–30/hr and TrustedHousesitters at $149–299/yr — $14.99/mo for
   multi-property tooling is cheap. Either raise Greenhouse to $14.99 and
   commit to the many-homes story, or fold it into Garden. Leaving it at
   $9.99 with a 76% COGS ratio and no story is the one thing not to do.
2. **Restoring annual is a separate, urgent problem.** Every competitor
   sells annually; monthly-only makes this the most expensive product in the
   category on a per-year basis. Annual was withdrawn because it ran 105–114%
   of COGS (ADR 0012), but that arithmetic was computed on tiers whose value
   _was_ inference. Re-cut, the marginal cost of a Garden household that uses
   the coordination toolkit and never identifies a plant is close to zero.
   This re-cut is the precondition for putting annual back; the price and the
   metering step are in ADR 0012's alternatives.

## Consequences

- **Marginal cost of this change is $0 per household per month.** Every cap
  here is a structural limit on rows that cost nothing to serve. The homes
  gate adds one `GetItem` per household the user belongs to, and only on
  create/join — a fraction of a cent per household per year at any plausible
  rate. The one AI number that moves (free identifications 3 → 1) *reduces*
  cost, by up to $0.117 per free household per month at the ADR 0012 price.
- **Existing Garden subscribers lose nothing.** Members go 6 → unlimited;
  plants go 500 → 200 for new growth only, and a household above 200 keeps
  every plant. New Garden households get a smaller plant cap and a much
  larger member cap. The analytics window is unchanged for paid tiers.
- **Existing free households above the new caps are grandfathered.** A
  free household with 4–6 members keeps them; a free user in several
  households keeps them; free's plant cap _rises_. What free households lose
  is the analytics window beyond 30 days (rendered, not stored) and the
  ability to add a fourth member or a second home.
- **The Terms' notice period applies.** The Terms promise usage limits stable
  for at least 14 days from announcement. Merging this is not deploying it;
  the deploy must follow an announcement, and the grandfather rule is what
  makes the announcement honest.
- **Public copy now says what the tiers are for.** The pricing page, landing
  band, help answers, store and SEO metadata drop the "paid plans lift those
  caps" framing for the three stories above, in both languages. Feature
  bullets on a public surface are limited to what is enforced in code today;
  the Away Kit, Plant Tags, toolkit, Move Day, kiosk and caretaker-seat
  bullets are added by the change that ships each feature, keyed off the
  `features` map.
- **Interaction with ADR 0012.** That decision reduced free's AI allowances
  and withdrew annual/lifetime; this one changes nothing about metering and
  keeps the withdrawals. The two together describe a free tier that is
  complete for a couple, costs at most $0.31/month at its AI ceiling, and has
  a reason to upgrade that is not inference.
- **Sitter limits are declared, not yet enforced.** `sitterLinkMaxDays` and
  `sitterLinksActive` are catalog fields the Away Kit reads; until it lands,
  `sitterService` keeps its current behaviour.
- **A capability flag is not a shipped feature.** `features` says what a tier
  INCLUDES. `awayKit`, `plantTags`, `householdToolkit`, `crossHomeToday`,
  `moveDay`, `kiosk` and `caretakerSeats` are declared here so the gates and
  the UI have one name to read, but no public surface advertises a bullet for
  them: `PaidPlanGrid`'s flag-driven list carries only `chat` and `apiKeys`,
  the two that are enforced in code today. Each remaining capability adds its
  own bullet in the PR that ships it.
- **The member roster is now paged.** `getHouseholdMembers` was a single
  100-row query, safe only while the largest member cap was 50. Garden and
  Greenhouse membership is unlimited, so it pages to exhaustion — a short
  roster would be a member the reminder fan-out silently never reminds.
