# 0016 — Plant Tags: account-free care actions from a printed QR label

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0003](0003-single-table-dynamodb.md) (row shapes), [ADR 0010](0010-settled-read-states.md) (the history read on the scan page), `backend/src/services/sitterService.ts` (the token model this narrows)

## Context

The product's stated failure mode is households sitting at one active member,
because member #2 will not install an app. Every sharing mechanism in the
competitive set answers that with "make them install it too". The one asset
this codebase already has that does not is the sitter link: a 256-bit,
revocable, PII-free, no-account credential.

Two other facts made this shape obvious. `GET /plants/:id/history` has always
carried "who last watered this" and nothing surfaced it. And a plant already
has a physical location in the house — the pot — which is exactly where the
person who would help is standing when they wonder whether it needs water.

So: print a QR label, stick it in the pot, and let whoever scans it see the
plant's last care and mark the due task done under a name they type once.

The obvious objection is the one that has to be answered before anything is
built: **a QR code in a pot is a credential in a photograph.**

## Decision

Issue a per-plant token modelled on the sitter link but scoped down, not
across, and treat the leakage case as the design's centre rather than a
footnote.

**Token.** 256 bits from `crypto.randomBytes(32)`, hex, as the DynamoDB
partition key (`PLANTTAG#{token}` / `METADATA`), mirrored onto GSI1 under
`HOUSEHOLD#{id}#PLANTTAG` so a household can list its own. A scan is one
`GetItem`. There is no enumeration surface and no ambient authority: the token
IS the capability.

**Scope: one plant, two verbs.** A tag resolves to exactly one plant and
authorises exactly two things — read that plant's care summary, and complete
one of _that plant's_ due tasks. The completion path checks
`task.plantId === tag.plantId`, not merely the household, so a forged task id
belonging to a sibling plant is refused. A tag can never read a member record,
another plant, the household's saved location, or private notes.

**No expiry; revocation instead.** A sitter link is a trip and expires. A
label in a pot is furniture, and an expiry date on it would mean silently
dead labels around the house. Revocation carries the whole burden, so it is
one click and immediate: `status: 'revoked'` short-circuits the next read, and
issuing a tag for a plant that already has one revokes the old one first —
"re-issue" and "issue" are the same call, which is what makes rotation a
single button. Revoked rows carry a TTL and sweep themselves; reads never
depend on the sweeper for correctness.

**Optional household PIN.** Four digits, off by default, admin-set, stored as
a salted scrypt hash (never the PIN), verified server-side on both public
routes, and presented in `X-Tag-Pin`. Wrong attempts are counted **on the tag
row in DynamoDB** and lock that tag for fifteen minutes after five — the
in-memory IP limiter is per warm container and multiplies with concurrency, so
it cannot be the brake on a 10,000-value space. A locked tag refuses even the
correct PIN, and the lock is checked before the candidate is examined so a
locked tag cannot be probed at all.

**Attribution.** A completion writes `actorId = tag:{tagId}` with the typed
display name, and the activity event carries `viaTag: true` — exactly parallel
to the existing `sitter:` / `viaSitter` pair. The household's feed says
"Grandma watered the Monstera", which is the activation event this feature
exists to produce.

**Plan gate.** `plans.ts` gains `limits.tags` and `features.plantTags`:
Seedling none, Garden 50, Greenhouse unlimited, read through one accessor
(`plantTagAllowance`) that publishes unlimited as `null` because `Infinity`
does not survive JSON.

**Printing.** A members-only page renders the labels as a plain grid with
`print:` variants, sized for A4 and Letter alike. QR codes are generated in
the browser by a ~300-line in-house encoder, so no token is ever handed to an
image service and nothing lands in the size budget for visitors who never open
the page. No label-printer integrations: the brief's second risk is that
printing is friction, and the answer to friction is "works on the printer you
already own".

## The threat model, stated plainly

**What a leaked tag is.** A photograph of the plant with the label legible —
posted to Instagram, in a listing photo, on a video call, or simply seen by a
visitor — publishes that token. Assume it happens. It is not an edge case; it
is the expected end state of some fraction of printed labels.

**What the holder of a leaked token can do.**

1. See one plant's name, species, photo URL, care notes, its due tasks, and
   who last cared for it **by first name only** — member names are truncated
   to the given name before they leave the server.
2. Mark one of that plant's due tasks complete, under any name they type.

**What they cannot do, and why.**

- **Reach another plant or another household.** The token resolves to a single
  `plantId`; every read and the completion write are scoped through it. There
  is no path from a tag to the household's plant list.
- **Reach a member.** No user ids, no emails, no full names, no roster.
- **Reach the household's location.** The climate location is deliberately
  excluded from the projection, as it is from the sitter view.
- **Learn whether a token exists.** Missing, malformed, revoked, and
  "the plant is no longer active" all return one identical 404, so the endpoint
  is not an oracle.
- **Delete, edit, snooze, or create anything.** Complete-only. There is no
  destructive verb on the surface at all.
- **Un-complete or backdate.** The completion advances the schedule by the
  task's own frequency from now; `expectedNextDue` makes a retried tap a no-op
  rather than a second cycle.
- **Brute-force the token.** 2²⁵⁶ with a per-IP limiter in front and a
  charset/length gate that rejects a non-token before it reaches DynamoDB.

**The blast radius, in one sentence: a stranger marks your monstera watered.**

That is the honest worst case, and it is worth naming what it costs. The
household sees a completion they did not make, attributed to a name they do
not recognise, in a feed that shows exactly which tag it came through. The
plant's next reminder moves out by one cycle — so the concrete harm is "a
plant might get watered a few days late because the app thought it was
already done", recoverable by anyone re-completing the task or editing the
schedule. It is annoying. It is not dangerous, and it is not private data.

**Why that trade is acceptable here and would not be elsewhere.** The same
mechanism pointed at "delete plant", "invite a member", or "read the
household's history" would be indefensible. It is defensible for _complete a
due care task_ because the action is low-value to an attacker, fully visible
to the household, individually reversible, and the alternative — requiring an
account — is precisely the barrier that keeps member #2 from ever helping.

**The three mitigations, and what each is actually for.**

- _Per-plant scoping_ bounds the damage of a leak that has already happened.
- _One-click revoke-and-reprint_ bounds its duration; the household notices a
  strange completion in the feed and can kill that label in a click without
  touching any other label.
- _The PIN_ prevents the leak from being usable at all, for households that
  photograph their homes. It is off by default because most labels are seen
  only by people already standing in the living room, and a PIN on the fridge
  is a small tax on the exact person the feature is for.

**What we deliberately did not do.** No IP allowlisting or geofencing (a
neighbour helping out is not on your Wi-Fi, and the whole point is that they
are physically present). No expiry (silently dead labels are worse than
revocable ones). No per-scan email notification (a household that tags twenty
plants would drown, and the activity feed already shows every completion).

## Consequences

- **Marginal cost is ~$0.001 per household per month.** One DynamoDB row per
  tag (a few hundred bytes; a 50-tag household is well inside a cent of
  storage), plus scans as API Gateway requests at $1/million. No inference, no
  image service, no printing cost to us. The feature is a rounding error
  against a $4.99 tier whose AI COGS ceiling is $2.67.
- **A new Lambda group** (`plantTags`) owns six routes: four authed
  management, two public. Route registration is append-only in `local-server`,
  the Terraform route map, and the group's own dispatcher.
- **`viaTag` joins `viaSitter`** on the task-completed payload. Renderers that
  do not know it yet simply show the actor name, which is already correct.
- **Any member may issue or revoke a tag; only an admin sets the PIN.** A tag
  grants strictly less than a member already holds, so issuing one is not a
  privilege escalation — unlike invites and sitter links, which hand out the
  whole household and stay admin-only. The PIN is household-wide posture, so
  it does not.
- **The QR encoder is ours to maintain.** ~300 lines, no runtime dependency,
  and correctness pinned by fixtures generated from an independent encoder. If
  it ever needs Kanji mode or structured-append it should be replaced by a
  library, and the byte cost argued then.
- **The scan page must keep its settled read.** A failed care-history read
  renders "we couldn't load care history", never "never watered" — the same
  rule ADR 0010 exists for, on the surface where a stranger is most likely to
  act on it.
- **A tag dies with its plant.** Deleting a plant revokes its tag; a tag whose
  plant is archived, died, or was given away stops resolving, so nobody is
  invited to water something the household stopped caring for.
