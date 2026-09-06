# 0017 — Cross-home Today is a work queue, not a global view

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0010](0010-settled-read-states.md) (a failed read is never a value); `docs/multi-household.md` (the "no global view" rule this record qualifies)

## Context

`docs/multi-household.md` states, deliberately: _"There is no global 'all my
plants' view by design — it would be confusing and would mix unrelated
households' data on the same screen."_ That rule has held since
multi-membership shipped, and every resource handler enforces it by refusing
any household other than the one pinned for the request.

The paid-feature brief (§4.3, §7) proposes **Cross-home Today**: one list of
everything due today across every home the caller helps with — their place, a
parent's place, the rental, a client's. Multi-home is the Greenhouse story
("many homes, many hands"), and this view is the one thing a second collection
makes possible that no single-collection competitor can copy.

The two appear to conflict. They do not, once the objection is read for what it
is about.

The objection is about **inventory**. A merged list of 200 plants from four
houses is confusing because a plant's identity depends on where it lives —
"the Monstera" means nothing across homes — and because it invites acting on
the wrong household's data. That is correct, and this record does not weaken
it.

A **work queue** has a different shape. "What do I owe today, and where?" is a
question whose answer is naturally partitioned by place. The person reading it
is one pair of hands moving between homes; the useful unit is "at Mom's: water
the fern, feed the fig; at the rental: nothing". The failure mode the rule
guards against — losing track of which home a row belongs to — is exactly what
grouping and labelling prevent.

Two more forces shaped the decision:

- **Roles differ per home.** The caller is admin here and member there. The
  membership row is authoritative for role (`docs/multi-household.md`), so any
  cross-home read has to resolve it per household, not once.
- **A missing home reads as an all-clear.** If one household's read fails and
  its group silently disappears, the reader sees "nothing due at the rental"
  when the truth is "we couldn't ask". The repo's named defect class (ADR 0010)
  applies with full force here, because the whole point of the page is to be
  trusted at a glance.

## Decision

Ship `GET /me/today` as the one cross-household read in the API, under three
rules that together keep the original design principle intact:

1. **Grouped and labelled, never merged.** The response is an array of
   households, each carrying its own `name`, the caller's `role` from that
   household's membership row, and that household's rows. Every row also
   carries `householdName`, so a row is self-describing even when rendered
   away from its group. There is no flat task list in the contract, and the
   page never renders one.
2. **A work queue, bounded to today.** Rows are what is due at or before the
   caller's own end-of-day (`?until=`, bounded to ±48h of now) plus anything
   overdue — the dashboard's existing `getUpcomingTasks` query run per
   household and filtered, not a new query. It is not an inventory and does
   not grow into one: no cross-home plants endpoint, no "all my plants"
   filter.
3. **Unavailable is a value; absent is not.** A household whose read fails is
   returned as `{ householdId, name, role, status: 'unavailable' }`. It is
   never dropped and never an empty `tasks: []`. The page renders it as "we
   couldn't reach this home", with a retry.

Consequences of that shape that are load-bearing:

- **The read is not household-pinned.** No `requireHousehold`, and
  `X-Household-Id` is irrelevant to it. Membership comes from the user's GSI1
  row set (`getMembershipsByUser`), the same source the household switcher
  uses.
- **Actions go back through the single-household routes.** Complete and claim
  on a row call `POST /tasks/{id}/complete` and `/claim` with an explicit
  `X-Household-Id` for that row's home. The resource handlers' cross-household
  refusal is untouched; the frontend's request interceptor was taught not to
  overwrite an explicit header with the active-household pin. Nothing gains
  the ability to write across households.
- **Gated per user, across memberships.** The view is a Greenhouse feature
  (`crossHomeToday` in `models/plans.ts`). A subscription belongs to a
  household, and its members are the "many hands" it is sold to, so the gate
  is: entitled if any household the caller belongs to is on a plan that
  includes it. Gating on the active household alone would lock the page the
  moment a paying member switched to one of their free homes. When no
  household grants it, the API answers 402 and the page shows the explanation
  on this URL — not a 404. When entitlement cannot be read, the API answers
  503: "we couldn't check" is not "you don't have it".
- **The household-count re-cut is out of scope here.** The brief pairs this
  view with capping free households at one, grandfathering existing users.
  That cap and its grandfathering are a separate change owned by the plan
  re-cut; nothing in this record depends on it.

## Consequences

**What we get.** The one view only a multi-membership product can produce, at
a marginal cost of roughly $0.0002 per household per month (N parallel reads
the app already runs, once per view; no new tables, indexes, or inference).
The "no global view" rule survives as written: still no global inventory, and
the multi-household doc now says why the queue is not one.

**What we accept.** N reads per view instead of one; for a user in ten homes
that is ten dashboard queries in parallel, which is fine at this scale and
would want a per-household cache before it wanted a materialised cross-home
index. "Today" is the caller's day as their client reports it; the server
cannot know a household's local day and does not pretend to. A user in a
Greenhouse home and a free home sees both — the entitlement is theirs, not the
free home's — which is the intended reading of "many hands".

**What this does not decide.** Whether "open this home" from a section should
stay (the page offers it by switching the active household and navigating —
a convenience, not a contract); how the household-count cap and its
grandfathering land (the re-cut's own record); and whether Greenhouse should
be priced for this story (§7 of the brief).
