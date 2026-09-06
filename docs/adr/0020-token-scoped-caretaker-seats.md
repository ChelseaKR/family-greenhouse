# 0020 — Caretaker seats are token-scoped identities, not accounts

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Builds on:** the plant-sitter link (`services/sitterService.ts`) — same
256-bit token, same window enforcement, same generic-failure posture.

## Context

The paid-feature ideation brief (§4.8) proposed "caretaker seats +
proof-of-visit" as a Greenhouse feature: named helpers who can log care and
photograph what they did, with a timestamped record the household can hand to
whoever is paying.

**The brief's own research argues against building it, and that research is on
the record here rather than buried.** §3.4 found no plant-sitting marketplace
anywhere; Thumbtack prices pet sitting at $115–185 per engagement and lists
"watering plants" among the unpriced _small errands_ a sitter "might be willing
to" do; TrustedHousesitters ($149–299/yr) never mentions plants at all. Plant
sitting is a favour, not a paid category. The brief's ranking dropped §4.8's
value from 5 to 3 on that finding and concluded: _do not build L-sized work for
a segment the market says isn't there_.

Two forces then meet. The feature was asked for anyway. And the brief itself
names the cheap version it would accept: **~$0.001/month per active seat if
seats stay token-scoped like sitter links, versus ~$0.06 if they become Cognito
users** ($0.0055/MAU above the free tier) — adding that "the 'no account'
property is a feature, not a limitation."

So the decision is not _whether_ but _at what size_, and the size question has
a defensible answer even under the brief's own scepticism: build the version
whose marginal cost is a rounding error and whose failure mode, if the segment
never appears, is a Greenhouse line item nobody uses rather than an accounts
system nobody uses.

The design question underneath is what a caretaker _is_. A household member is
a Cognito user with a `HouseholdMember` row, and members can do a great deal:
create and edit plants, manage other members, open billing, change settings,
read the activity feed and analytics, export. A caretaker needs almost none of
that, and giving them a member row to take it away again is the wrong shape.

## Decision

**A caretaker is a named, revocable, time-boxed, token-scoped identity attached
to one household.** Concretely:

1. **No account.** A 256-bit CSPRNG token in the URL is the only credential,
   stored at `PK = CARETAKER#{scrypt(token)}` so a lookup is one `GetItem` with
   no enumeration surface _and_ a table export yields a digest rather than a
   live seat (#568; the same migration #551 made for sitter and kiosk links).
   Seats minted before that keep their plaintext row and keep working — the
   read falls back to one more point read on the legacy key, because a
   caretaker has no account and cannot ask for a replacement link. No Cognito
   user, no password, no email, no sign-in.
2. **Named.** Unlike a sitter link — whose completions read "a plant sitter" —
   a seat carries the name the household typed, and every action it takes is
   attributed to that name in the activity feed and in the report. The name is
   denormalised onto each visit record at the time it happens, so a later
   rename or revocation never rewrites history.
3. **A permission surface strictly narrower than `member`**, enumerated in
   `CARETAKER_PERMISSIONS` and nothing else:
   - `task.complete` — tick off a due task
   - `photo.add` — add a photo to a plant
   - `note.add` — leave a note about the visit

   `CARETAKER_FORBIDDEN_CAPABILITIES` records the member powers a caretaker
   must never gain (plant create/edit/delete, member invite/remove/role,
   billing, household settings, sitter and caretaker management, activity,
   analytics, export). The two lists are asserted disjoint in tests, and the
   integration suite asserts no other route exists under `/caretaker/{token}`.
   Widening the surface is therefore a deliberate act that changes this ADR,
   not a route someone quietly adds.

4. **Proof of visit is a per-visit record, not a log filter.** A visit is a
   contiguous run of that caretaker's actions; its `startedAt` is the timestamp
   of the run's **first action**, which makes the arrival time observed rather
   than self-declared. A gap longer than `VISIT_IDLE_MS` (6 hours) starts a new
   visit, so lunch does not split a visit and yesterday does not merge with
   today. `GET /households/{id}/caretaker-report?from&to` renders the range.
5. **The gate is `features.caretakerSeats` in `models/plans.ts`, Greenhouse
   only — on the CREATE path alone.** Listing, revoking and reporting stay open
   on every tier, because a paywall in front of the only control that stops a
   live credential is a security bug, not an upsell.

## Consequences

**What we accept.**

- Revocation is total and immediate but visits are kept: they are the
  household's record of work that actually happened, and deleting them to
  "clean up" would destroy the artefact the feature exists to produce. Account
  erasure still removes them, along with the seats themselves — both partitions
  are swept by `deleteAbandonedHouseholdData`.
- A caretaker cannot be reached by the product: no email, no push, no reminder.
  That is the price of no account, and it is the right price — the household is
  the one with the schedule.
- Visit rows cap stored detail at `VISIT_DETAIL_CAP` entries per kind while
  keeping exact counters, so a single item cannot approach DynamoDB's 400 KB
  limit. Where the two disagree, the report states how many lines it cannot
  show. It never presents the shorter list as the whole story (ADR 0010).
- A task completion whose visit line fails to write returns
  `visitRecorded: false` rather than a plain success, and the caretaker's page
  says so. The task really did complete; pretending the record is intact would
  be exactly the "absence rendered as a value" defect this codebase names.
- `listVisits` does not catch. A report that cannot read its data says so
  instead of rendering an empty visit, because "nobody came" and "we could not
  look" are opposite claims to the person being handed the page.

**What we are explicitly NOT doing, and why.**

- **Not the L-sized build.** No caretaker accounts, no caretaker-side
  multi-client dashboard, no marketplace, no invoicing, no ratings, no
  scheduling. The research says that segment does not exist as a paid category;
  building for it would be inventing a customer.
- **Not Cognito users.** ~$0.06/month per active seat against ~$0.001, in
  exchange for a sign-up step that makes the product worse for the exact person
  it is for.

**What would justify going further.** This ADR should be revisited — and only
then — on evidence, not enthusiasm:

1. a real plant-sitting business (or a household paying a named caretaker on a
   recurring basis) using the product, which the roadmap's B2B gate already
   requires before any B2B code;
2. caretaker seats being created and _used_ — visits recorded, reports pulled —
   by more than a handful of Greenhouse households, since a seat that is minted
   and never opened measures curiosity, not demand; and
3. a named request for something the token model genuinely cannot serve (one
   caretaker across several client households in one view, say), rather than a
   preference for accounts in the abstract.

Absent those, the correct next investment is §4.1 (the Away Kit), which serves
the handoff the research says actually happens at volume: householder →
neighbour.
