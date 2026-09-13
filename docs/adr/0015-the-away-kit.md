# 0015 — The Away Kit: sitter links become the product's paid differentiator

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0010](0010-settled-read-states.md) (a failed read is never a
value), [ADR 0011](0011-categorical-pet-safety-claims-block.md) (pet-safety
claims come from the curated table or not at all)

## Context

The sitter link is the most differentiated thing in this product. It is a
256-bit, time-boxed, revocable, PII-free, no-account credential; the two
nearest competitor features (Planta's Care Share, Plantum's Vacation Mode)
both require the helper to install an app and register, and neither documents
expiry, scope, or revocation. We already own the hard half.

It shipped in a state that gave that away and then broke it:

1. **The task view ignored the window.** `startsAt` / `expiresAt` were modelled
   on the link and enforced for _access_, but both task-view paths looked a
   hardcoded seven days ahead. A household that set a three-week link — the
   exact case the feature exists for — showed its sitter only the first week
   of work, silently.
2. **Only admins could create a link.** The person who travels is not reliably
   the person who administers the household. A member facing a trip could not
   arrange cover at all.
3. **The link carried a task list and nothing else.** Everything the sitter
   actually needs to do the job well — where the plant lives, how this
   household waters it, whether the cat can be poisoned by it, what it looks
   like — is already recorded and was not shown.

## Decision

Ship the Away Kit: the window fix and member access for everyone, the brief
for Garden and up.

**(a) The window fix ships free, on both paths.** It is a bug, not a feature.
The window was already the household's stated intent and already governed
access; a task view that contradicts it is wrong at every tier, and charging
to correct it would be charging for a defect. `getSitterTasks` now takes the
link's `expiresAt` as its lookahead, and the local dev server mirrors it.

**(b) Any member can create, list and revoke sitter links.** `requireAdmin`
comes off all three routes. This deliberately widens who can mint a credential
that reaches into the household, so the revocation model carries the weight:

- an **admin** may revoke **any** of the household's links;
- a **member** may revoke **only the links they created** (403 otherwise, and
  the target link is not touched);
- both paths are scoped to the household, so no link of another household is
  ever reachable by id;
- creating and revoking now emit `sitter_link.created` / `sitter_link.revoked`
  activity events naming the actor, the label and the window — never the token
  — so widening the door also makes it visible who opened one and until when.

Invites stay admin-only. A sitter link grants a time-boxed, PII-free task view
that expires by itself; an invite grants permanent membership. They are not
the same risk and do not deserve the same gate.

**(c) The free/paid line is the window and the brief.** Two fields on the plan
catalog (`limits.sitterLinkMaxDays`, `limits.sitterLinksActive`) and one
derived rule:

|                    | Seedling (free) | Garden / Greenhouse |
| ------------------ | --------------- | ------------------- |
| Window             | ≤ 7 days        | ≤ 90 days           |
| Live links at once | 1               | 10 / 25             |
| Task list          | ✓               | ✓                   |
| Handoff brief      | ✗               | ✓                   |

Free is complete for a weekend away, which is the honest majority case. The
traveller with a three-week trip hits a wall at the moment of real anxiety
about things they love, and the wall names what lifts it. Over-cap creates
answer **402** — the request is well-formed and only lacks entitlement, the
same code and client handling as the plant cap. The 90-day figure is also the
schema's absolute ceiling, so a crafted request cannot outrun the plan check.

**(d) The brief is a template render, and its silences are load-bearing.**
`GET /sitter/{token}/brief` returns, per plant: name, space name, placement
note, the household's own care words (`careRule`; see the 2026-09-13 amendment
below — the `notes` fallback this decision shipped has been withdrawn), the
latest photo, the verified pet-toxicity entry, and the tasks due inside the
window. No inference, no
model call, nothing generated. Two absences are rendered as absences:

- a plant with no note **says it has no note**. A sitter cannot tell invented
  care advice from the household's own instruction, and following the wrong
  one is how a plant dies;
- a plant our curated, ASPCA-grounded table does not know shows **no verdict at
  all** (ADR 0011). Silence is honest; an unearned "pet-safe" badge is not.

The photo is the one field that needed work to stay inside the link's
boundary. `plant.imageUrl` is a CloudFront URL on a behavior with no viewer
authorization, cached at the edge for a year, so handing it to a sitter used to
outlive the link entirely: a saved page, a copied URL, or a browser cache kept
fetching photographs of the inside of the house long after the link expired or
was revoked, and so did anyone the sitter forwarded them to. The brief now
signs each photo URL with a TTL clamped to what is left of the link (ceiling one
hour, re-signed on every fetch), so the photograph dies with the page. A stored
URL that cannot be resolved to a key inside the household's own
`plants/{householdId}/` prefix yields **no photo** rather than the permanent
public URL — fail closed (#453).

On a plan without the brief the endpoint answers the **same generic 404** as an
invalid token: an anonymous sitter is not the buyer and is never told which
tier a household is on. The task view carries a `briefAvailable` flag so the
page offers the link only when it will open.

**(e) The brief's risk is met before the trip, not after.** The honest risk is
that the brief is only as good as `notes` and `placementNote`, which are
optional and frequently empty — a brief reading "no note" for twenty plants is
worse than nothing. Creating a link therefore counts the gaps first ("6 plants
have no watering note — your sitter will be guessing") and links straight to
each plant. That turns the weakest input into the strongest pre-trip prompt,
at the one moment someone cares enough to write the sentence down. A failed
plant read says it could not check rather than reporting zero gaps (ADR 0010).

## Consequences

- **Marginal cost: ~$0 per household per month.** The brief is a template
  render over rows already stored and photos already in S3; no inference, no
  new storage, no new object writes. If a link is ever mailed rather than
  copied, SES is $0.0001 per send. The one new anonymous read is a plan lookup
  on the sitter view, which is a single already-cached DynamoDB get.
- **The unauthenticated read surface grows by one route.** It is rate-limited
  tighter than the task view (30/min per IP vs 60), validates the token on
  every call, and returns the same PII-free posture: no member identity, no
  saved climate location, no task notes. ("No household id" was also claimed
  here and is not true: the opaque id is inside the signed photo URL, because
  the S3 key contains it and a presigned URL cannot hide the key it signs. See
  the 2026-09-13 amendment.)
- **The brief shows plant care notes to the sitter, which the task view never
  did.** That is a deliberate change to what a sitter link exposes, and the
  privacy page now says so. Task-level notes remain private. **Superseded by
  the 2026-09-13 amendment below: the privacy page never said so, and the
  `notes` half of this has been withdrawn.**
- **More people can mint tokens.** Accepted, with the revocation model and the
  activity events above as the control. If abuse ever appears, the next lever
  is a per-member live-link cap, not re-closing the door to members.
- **`careRule` is read defensively.** The structured per-plant care rule (the
  House Rules idea) may land separately; until it does, the brief falls back to
  `notes` and labels which field it used. **That "until it does" has arrived —
  see the amendment below.**
- **Two client-side mirrors of plan numbers now exist** (the create form's cap
  copy and the gap prompt's field checks). The backend remains the authority
  and refuses an over-cap request regardless; the mirrors exist so the wall is
  visible while typing rather than after submitting. They must be kept in step
  with `plans.ts`, and both files say so.

## Amendment — 2026-09-13: the `notes` fallback is withdrawn (#709)

**(d) above shipped a fallback that the published privacy policy forbade.**
`legal.privacy.sitter.body` has said, since before this ADR was written, that
"sitter links do not expose your saved household location, plant or task
private notes, or household member identity and contact details." This ADR's
consequence list claims "the privacy page now says so"; the commit that shipped
the brief did not touch the privacy page, and the sentence was never changed.
Measured end to end against the real handlers, a plant whose `careRule` was
empty returned its `notes` word for word to an unauthenticated bearer link.

**The fallback is removed, not the sentence.** A privacy policy is not edited
to match a leak. `resolveCareNote` now reads `careRule` only, and a plant with
no rule renders as the absence it already rendered when both fields were empty
— the "a missing note stays missing" rule in (d) was always the fallback's own
safety net, so nothing new had to be invented for it. This is also this ADR's
own exit condition, taken: the bullet above kept the fallback only "until
[`careRule`] lands", and it has — the House rule field is on the plant form, in
`createPlantSchema`/`updatePlantSchema`, and on `Plant`.

**The policy's positive enumeration was separately incomplete**, and that half
was fixed in the copy, because completing it discloses more rather than less.
The paragraph listed only what the free task view shows; the paid brief also
carries the house rule, the curated pet-toxicity entry and a signed photo URL,
and lets the sitter write (a photo back to a plant's timeline). All of it is
now named in `legal.privacy.sitter.body` in both locales.

**What holds the line now:** `backend/tests/integration/sitter-privacy.test.ts`
builds a real link through the real handlers, fetches both sitter endpoints
anonymously, and asserts each clause of the published paragraph against the
actual payload — including that a plant's `notes` never appear in it. It fails
if the fallback returns.

**One claim corrected rather than fixed.** The consequence list above said the
brief returns "no household id". It does return one — inside the signed photo
URL, since the S3 key is `plants/{householdId}/{plantId}/{file}` and a
presigned URL cannot hide the key it signs. That is not a promise the privacy
page makes (an opaque household UUID is not a saved location, a private note,
or a member identity), it grants nothing on its own (`authMiddleware`
re-validates an `X-Household-Id` override against the membership row), and it
reaches only a holder of a live token for that same household. Hiding it would
mean proxying every photo read through the API, which is a different decision
from this one. The sentence is corrected here and in the handler comment, and
the test pins the true shape: the id appears in the photo URL and nowhere else.
