# 0047 — An invite admits a limited number of people and can be turned off

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0014](0014-plans-drawn-on-homes-and-hands.md) (member and home caps, which still
apply to every join).

## Context

A household invite was a link that worked for 7 days, for anyone who had it, any number of times.
Nothing could end it sooner. When a member was removed, the sitter links, plant tags and other
credentials they had made were revoked, and invites were not.

An invite is a way into a household's plants, photos, tasks and member names. Its life has to end
when the household wants it to, and removing someone has to mean that a link they still hold does
not bring them back.

## Decision

1. **An invite admits a limited number of people.** A link admits up to 5. An invitation the app
   emails to one address admits 1. Both still expire after 7 days.
2. **Limited-use for links, not single-use.** A link is made to be passed around a household, often
   pasted once into a family chat. Single-use would make the second person's link fail with no way
   for them to know why, and would break a link that is pending today and already shared with
   several people. Five covers a household; the plan's own member cap still applies underneath it.
   Single-use fits the emailed invite, which was addressed to one person.
3. **Every invite a household has made stops working when a member leaves or is removed.** That
   covers removal by an admin, leaving, and deleting an account. It is one field on the household
   row, `invitesRevokedAt`, written in the same transaction that removes the member. An invite
   created at or before that instant is refused.
4. **An admin can turn the household's invites off.** `DELETE /households/{id}/invites` sets the same
   field. The Household page has a "Turn off invite links" control. There is no list of invites to
   pick from: an invite's code is shown once, when it is made, and is stored nowhere it can be read
   back from, so the control turns off all of them. Invites made afterwards work.
5. **The use is taken atomically.** Joining adds the member, raises the household's member count,
   checks `invitesRevokedAt`, and takes one use of the invite in one DynamoDB transaction. Two people
   cannot both take the last use, and a join cannot land beside the write that turned the invite off.
6. **Pending invites keep working.** A row written before this change has no count. It reads as a
   link with all 5 uses left, and is counted from its next use.

## Consequences

- A link shared with more than five people stops at the fifth. The sixth sees the same "invalid or
  expired" page as for any dead link, and an admin makes another.
- **A pending invite dies when anyone leaves the household,** not only when someone is removed.
  Removal and leaving run the same departure sequence here on purpose, and a person asked to leave
  is the same case as a person removed. The cost is that an admin who had an invite out to somebody
  else has to send it again.
- A join that the plan refuses (member cap, home cap) does not use the invite up, and neither does
  somebody who is already a member.
- No new index and no new row: one field on the household row, two on the invite row.
- Not built: a list of pending invites with one-by-one revoke, and a record of the turn-off in the
  household's audit card. Either can be added on top of this.
