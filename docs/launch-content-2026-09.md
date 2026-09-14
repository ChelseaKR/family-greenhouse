# Launch content — Product Hunt, Show HN, Reddit (2026-09)

**Status: DRAFT ONLY.** Nothing in this document has been posted anywhere. No
account was created on Product Hunt, Hacker News, Reddit, or anywhere else
while writing it. Every product claim below is grounded in a specific file in
this repo (cited inline) or in `backend/src/models/plans.ts`; nothing is
invented. There is no user count, testimonial, or traction metric anywhere in
this doc — the product has zero sales as of this writing, and this content
does not claim otherwise.

This is the free/organic public-launch lane. A separate, same-day lane is
doing Meta/Google paid-ads creative and keyword work for Family Greenhouse —
this doc doesn't touch that; it's unpaid launch posts only.

Pricing used throughout (from `backend/src/models/plans.ts`, current as of
2026-09-14): **Seedling** is free. **Garden** is **$4.99/mo**. **Greenhouse**
is **$9.99/mo**. Annual and lifetime cadences exist in the catalog but are
currently _withdrawn from new sale_ (`withdrawnIntervals`, ADR 0012/0014) — so
this content only ever quotes the monthly price, never an annual figure a new
signup couldn't actually buy today. Gift subscriptions are a real, shipped
feature (`frontend/src/features/billing/GiftSubscriptionCard.tsx`, ADR 0028).
New households also get a real, no-card-required 14-day Garden trial
(`NO_CARD_TRIAL_DAYS = 14` in `plans.ts`) — worth leading with, since "try the
paid tier free, no card" is a strong, true hook nobody has to take on faith.

---

## 1. Product Hunt listing

### Tagline (pick one — all ≤60 characters)

1. **"Shared plant care for your household, safe for your pets"** (56 chars) — primary recommendation, leads with the two most differentiated things (household sharing + pet-safety data) rather than "another plant app."
2. "Plant care your whole household actually shares" (47 chars)
3. "Never wonder who watered the Monstera again" (43 chars) — a direct callback to the README's own line, so it's honest voice, not invented copy.

### Full description

> **Family Greenhouse is a shared plant-care journal for the whole
> household** — not a single-owner tracker. Add your plants, set watering /
> fertilizing / pruning schedules, and let anyone in the house claim a task
> and check it off. If a task sits overdue too long, the household toolkit
> quietly puts it up for grabs and tells everyone once — nobody has to
> nag anybody about the Monstera again.
>
> Three things make it more than a to-do list for leaves:
>
> **Pet-safety data you can trust.** Every plant's toxicity line is pulled
> straight from the ASPCA's own plant-safety data and shown verbatim — never
> AI-generated, never paraphrased. There's also a free, no-signup checker at
> familygreenhouse.net/pet-safe: type a plant name, get a plain-language
> answer on whether it's safe for cats and dogs.
>
> **Sitter links that need no account.** Going away? Generate a time-boxed
> link and text it to whoever's watering your plants. They open it, see
> exactly what's due in plain language ("Water the Monstera"), and tap
> Done — no app download, no account, no access to anything else in your
> household. The link expires on its own.
>
> **A per-plant page for every plant**, with a photo timeline, a care-streak
> history, species-specific care guidance, and its pet-safety note, all in
> one place.
>
> **Pricing:** Seedling is free — 3 household members, 20 plants, one
> 7-day sitter link, no card required, ever. Garden is $4.99/mo and adds
> unlimited members, 200 plants, longer/more sitter links, an AI plant-care
> assistant, and printable plant tags. Greenhouse is $9.99/mo and adds
> multi-home support, a wall-display kiosk view, and named caretaker seats
> for paid help. New households also get a free 14-day trial of Garden, no
> card needed. Gift subscriptions are available too.
>
> Built solo, live at familygreenhouse.net. Real feedback — especially on
> what's confusing or missing — is genuinely wanted.

### Gallery-image suggestions (5 concrete screens/moments)

Each of these is a real, shipped screen — not a mockup. Suggested capture
order, screen, and why:

1. **The per-plant page** (`frontend/src/features/plants/PlantDetailPage.tsx`,
   `PhotoTimeline.tsx`, `PetToxicityNote`) — show a plant with a few photo
   timeline entries, its care streak, and its pet-toxicity note visible on
   the same page. This is the single best "oh, that's nice" screen because
   it shows three differentiators (photos, streaks, pet safety) at once.
2. **The pet-safety checker mid-search**
   (`frontend/src/features/petsafe/PetSafePage.tsx`, `/pet-safe`) — a typed
   query returning a clear toxic/non-toxic verdict for a well-known plant
   (e.g. pothos or a lily). This is the free, no-signup hook — it should look
   inviting to someone who has never heard of the app.
3. **The sitter view** (`frontend/src/features/sitter/SitPage.tsx`,
   `/sit/{token}`) — the phone screen a sitter with no account sees: a short
   list of due tasks in plain language and a Done button. Capture it looking
   like a text-message-shared link opened on a phone, since that's the real
   use case.
4. **The household task list with the auto-handoff / care-load view**
   (`frontend/src/features/household/HouseholdPage.tsx`,
   `AutoHandoffCard.tsx`, `CareLoadCard.tsx`) — shows several members'
   names against shared tasks, which sells "this isn't a single-user app"
   at a glance.
5. **The plans page** showing all three tiers side by side plus the gift-
   subscription option (`frontend/src/features/pricing`,
   `frontend/src/features/billing/GiftSubscriptionCard.tsx`) — Product Hunt
   viewers who like the product often go straight to "what does it cost,"
   so having pricing as a gallery image (not just a link) reduces drop-off.

### Maker's first comment (draft)

> Hey PH 👋 — maker here, and this is a solo project.
>
> Family Greenhouse started from a boring, recurring argument in my own
> house: whose turn was it to water the Monstera, and did anyone actually
> check whether the new plant on the counter was safe to have around the
> cat. Most plant-care apps I tried were built for one person's collection.
> None of them were built for a _household_ — multiple people, a pet in the
> mix, and someone who needs to step in for a week when you travel.
>
> A few things I'm proud of, technically and otherwise:
>
> - The pet-safety data is sourced straight from the ASPCA's own plant list
>   and shown verbatim — I didn't want to generate or paraphrase anything
>   on a fact where being wrong could hurt an animal.
> - Sitter links need zero account creation on the sitter's side — you
>   share a link, it expires on its own, and it only ever shows care tasks,
>   never anything private about your household.
> - The free tier (Seedling) is a complete plan, not a crippled trial — 3
>   members and 20 plants, forever, no card. If you want more (unlimited
>   members, the AI care assistant, printable plant tags), Garden is
>   $4.99/mo, and there's a 14-day free trial of it with no card required.
>
> I'd genuinely love feedback — especially anything confusing in the first
> five minutes, or a household-sharing/pet-safety use case I haven't
> thought of. Thanks for taking a look.
>
> _(Optional, your call: the repo's README already carries a public
> dedication to my mom, Joyce, who's part of why "keep growing" is the
> whole idea behind this. Add or cut that here as you see fit — I didn't
> want to write that part for you.)_

---

## 2. Show HN

### Honest fit assessment first

**Yes, this clears the Show HN bar — but only if the post leads with the
engineering, not the app.** HN's own guidance is narrow: something you
personally built that people can actually try, not a landing page or a
funded-startup announcement. Family Greenhouse qualifies (it's live, free to
sign up, no card needed to try Garden for 14 days), and there are three
genuinely technical decisions worth an HN audience's time, not just "cool
consumer app" framing:

1. **Caretaker seats are deliberately not Cognito users.** They're
   token-scoped identities specifically because a real Cognito MAU costs
   ~$0.06/month and a token-scoped seat costs ~$0.001/month in DynamoDB
   writes (`docs/adr/0020-token-scoped-caretaker-seats.md`,
   `frontend/src/features/household/CaretakerSeatsCard.tsx`) — a genuine
   cost-driven architecture call for a feature that's otherwise identical
   to "give someone an account."
2. **The AI plant-care chat is grounded on purpose, not just prompted
   well.** It's Bedrock-hosted Claude with read-only tool access to your
   own plants/tasks/climate data, RAG over a bundled care corpus, and a
   dedicated grounding guard (`backend/src/services/chat/groundingGuard.ts`,
   tested in `chatGroundingGuard.test.ts`) specifically so it can't
   hallucinate a pet-toxicity answer — the one place in the app where a
   wrong AI answer does real harm. It's also metered per plan
   (`backend/src/services/chat/budget.ts`) so a free trial can't run up
   unbounded inference cost.
3. **Sitter links expose no household identity by design** — the public
   `/sit/{token}` endpoint is served by a bare-fetch service with no auth
   interceptors and deliberately omits member identity, precise location,
   and private notes; only the current task list and a short placement
   note are in scope (`frontend/src/features/sitter/SitPage.tsx`).

If the post reads as "look at my plant app," it'll get buried or flagged as
marketing — HN is reliably skeptical of consumer-app posts that don't have
substance under the hood. If it leads with #1–#3 above and treats the plant
tracker as the vehicle rather than the headline, it's a legitimate Show HN.
**Product Hunt and r/SideProject are the safer bets if this post doesn't
land; HN is the highest-upside, highest-variance channel of the three.**

### Title

> Show HN: Family Greenhouse – shared plant care, with a grounded AI assistant

(75 characters — under HN's title limit, and it foregrounds the technical
angle rather than the generic pitch.)

### Body

> Family Greenhouse is a plant-care app built around a household, not a
> single owner — shared task lists, claimable care tasks, and time-boxed
> sitter links for when you travel. I built it solo; it's live at
> familygreenhouse.net, source is public on GitHub under the Elastic
> License 2.0 (source-available, not OSI open source, by choice).
>
> A few things that might be interesting beyond "yet another plant
> tracker":
>
> **The AI care assistant is grounded, not just prompted.** It's
> Bedrock-hosted Claude with read-only tool access to a household's own
> plant/task/climate data and RAG over a bundled plant-care corpus. Pet
> toxicity is the one place a wrong AI answer causes real harm, so there's
> a dedicated grounding guard that keeps the model from generating a
> toxicity verdict — those come only from a hand-reviewed table sourced
> from the ASPCA's own data, never from the model. Usage is metered per
> subscription tier so a free trial can't run up unbounded inference
> cost.
>
> **Caretaker access is token-scoped, not account-based, for a cost
> reason.** Paid plant sitters/caretakers get a named, revocable,
> time-boxed identity rather than a real user account — a token-scoped
> seat runs about $0.001/month in DynamoDB writes versus roughly
> $0.06/month for a Cognito MAU, and at the scale a household actually
> needs (a few seats, not thousands of users) that difference is what made
> the feature worth shipping at all instead of gating it behind "invite
> them as a full member."
>
> **Sitter links are auth-free by design.** Someone watering your plants
> for a weekend opens a link, sees due tasks in plain language, and taps
> Done — no account, no app install. The endpoint behind it deliberately
> exposes no member identity, precise location, or private notes; only
> the current task list and a short placement note.
>
> Stack is React + TypeScript on the frontend, AWS Lambda + DynamoDB
> (single-table) + Cognito on the backend, with a local Express server
> that mirrors the API so the whole thing runs offline with no AWS
> account needed for development.
>
> Free tier is a real plan (3 members, 20 plants, no card, no time
> limit), not a crippled trial. Happy to answer anything — architecture,
> the AI grounding approach, or product decisions I probably got wrong.

---

## 3. Subreddit posts

### Verification method and its limits

Reddit itself blocked every automated fetch attempt in this session — a
blanket 403 on `reddit.com` and `old.reddit.com` regardless of which
subreddit or endpoint was requested (confirmed by testing a subreddit that
doesn't exist and getting the identical 403). So **no subreddit's exact
sidebar rule text was directly read** in preparing this section. Existence
and general character were cross-checked instead against third-party
subreddit-stats sites (subredditstats.com, gummysearch.com, reddapi.dev) and
independent articles about these communities. Where that leaves real
uncertainty, it's called out explicitly below — **do a final in-browser rules
check on each subreddit immediately before posting**, since Reddit's own
Automod rules (karma/account-age minimums, required flair, promo-only
threads) can't be verified from outside.

### Ranked candidates

| Subreddit            | Verified?                                                    | Size (approx.)     | Self-promo risk              | Approach taken                             |
| -------------------- | ------------------------------------------------------------ | ------------------ | ---------------------------- | ------------------------------------------ |
| r/SideProject        | Confirmed exists; self-promo is the sub's explicit purpose   | ~180K              | **Low**                      | Direct launch post                         |
| r/houseplants        | Confirmed exists (3.0M members, cross-checked via 2 sources) | 3.0M               | **Medium-high**              | Value-first resource post, no direct pitch |
| r/IndoorGarden       | Confirmed exists (~1.1M members)                             | 1.1M               | **Medium-high**              | Value-first resource post, no direct pitch |
| r/plantclinic        | Confirmed exists ("we diagnose your sick plants")            | unknown (mid-size) | **Not applicable — dropped** | Not used; see below                        |
| r/PlantsForBeginners | **Could not verify it exists**                               | unknown            | n/a                          | Not used; see below                        |

Reasoning for each:

**r/SideProject** — its own self-promotion norms (cross-checked via a
subreddit-rules aggregator) explicitly want a live, working product with
real screenshots and a genuine "why I built this" story, and explicitly ban
waitlist/email-gate posts. Family Greenhouse has a live product with real
Stripe checkout, so it clears that bar cleanly. This is the lowest-risk,
highest-confidence post of the three.

**r/houseplants and r/IndoorGarden** — both are large, general-interest
plant communities (3.0M and ~1.1M members). I could not confirm their exact
self-promotion rule text, but the evidence available points toward caution:
large general-interest subreddits in this exact category are documented
elsewhere enforcing hard against self-promotional links — one gardening
writer describes a two-week suspension from the comparably-sized r/gardening
for posting a single blog link. Rather than risk a removed post (or a ban)
with a direct pitch, I adapted these two per the brief's suggested
fallback: **a genuinely useful, value-first post that leads with a free
resource, mentions the app only as an aside, and never asks for signups or
posts pricing.** That framing is allowed by essentially every subreddit's
rules, even the ones that ban outright advertising, because it's judged as
a contribution rather than a promotion.

**r/plantclinic — dropped.** The subreddit's entire format, confirmed via
its own description ("we diagnose your sick plants"), is diagnosis threads:
someone posts a photo of an ailing plant and the community identifies the
problem. There's no framing — value-first or otherwise — where a launch
post (even a soft one) fits that format; it would be off-topic regardless
of the sub's stated self-promotion policy. Recommend skipping it for this
campaign rather than forcing a post that doesn't match how the community
actually posts.

**r/PlantsForBeginners — dropped, unverified.** Despite repeated searches
and cross-checks against three different subreddit-stats sites, I found no
independent confirmation this subreddit exists under that exact name (it
returned nothing on subredditstats.com, gummysearch.com, or in any
plant-subreddit roundup article checked). It's possible it exists as a
small/low-activity community neither indexed nor written about, or that the
name is slightly different. **Don't post here until you've confirmed in
your own browser that it exists and read its current rules** — if it turns
out to be real and welcoming to self-promotion, the r/houseplants
value-first draft below can be adapted for it directly.

### Draft: r/SideProject

> **Title:** Family Greenhouse – shared plant care for a household, built
> solo (real Stripe checkout live)
>
> **Body:**
>
> Hey r/SideProject — sharing my solo project: Family Greenhouse
> (familygreenhouse.net), a plant-care app built around a _household_
> instead of a single owner.
>
> What it does: everyone in the house sees the same plant list and task
> list, tasks can be claimed by anyone, and overdue tasks quietly get
> reassigned instead of just sitting there. If you travel, you can hand a
> time-boxed link to a sitter — they see what's due in plain language and
> tap Done, no account needed on their end. There's also a free,
> no-signup pet-toxicity checker (ASPCA-sourced data, not AI-generated)
> at /pet-safe.
>
> Stack: React + TypeScript, AWS Lambda + DynamoDB + Cognito, with a local
> Express server that mirrors the whole API so development doesn't need
> an AWS account. Source is public on GitHub.
>
> Pricing: free tier is a complete plan (3 members, 20 plants, no card,
> forever). Paid tiers are $4.99/mo and $9.99/mo, and there's a 14-day
> free trial of the paid tier with no card required. Real payments have
> been live since September 1.
>
> Zero users so far outside my own household testing it — this is
> genuinely the first public post about it. Would love feedback on
> anything: onboarding, pricing, whether the sitter-link idea makes
> sense to someone who isn't me.

### Draft: r/houseplants (value-first)

> **Title:** Made a free, no-signup checker for whether a houseplant is
> toxic to cats/dogs (ASPCA-sourced) — sharing in case it's useful
>
> **Body:**
>
> I kept ending up down a rabbit hole every time I brought home a new
> plant, trying to confirm whether it was actually safe to have around
> my pets — a lot of the search results are contradictory or just
> re-paraphrase each other. So I put together a small, free tool that
> answers it directly: type a plant's common name, get a plain-language
> toxic/non-toxic verdict pulled straight from the ASPCA's own plant
> list (not AI-generated — it's a hand-reviewed table).
>
> It's at familygreenhouse.net/pet-safe, no signup needed. It currently
> covers 24 common houseplants and I'm slowly adding more. Figured this
> community would actually know if the verdicts look right, or if I'm
> missing an important plant — genuinely open to corrections.
>
> (It's part of a bigger plant-care app I built, but the checker itself
> is free and doesn't require using the rest of it — happy to answer
> questions about either if anyone's curious.)
>
> _Before posting: confirm current flair requirements and whether a
> Resource/Tool-type post like this is welcome under this sub's live
> rules — I couldn't verify the exact sidebar text for this draft._

### Draft: r/IndoorGarden (value-first)

> **Title:** How I handle plant-sitting while traveling, without giving a
> sitter my account (built a small tool for it)
>
> **Body:**
>
> Every time I've traveled and had someone water my plants, the
> instructions ended up as a scattered text thread — "the fern needs
> water Tuesday, don't overwater the snake plant, the new one by the
> window is fine to skip." So I built a small feature to solve just this:
> a link you generate before you leave, good for a set window, that
> shows whoever's covering for you a plain-language list of what's due
> ("Water the Monstera") with a Done button — no account or app install
> on their end, and it expires on its own when the window's up.
>
> It's part of a household plant-care app I built (familygreenhouse.net)
> — the free tier includes one 7-day sitter link if anyone wants to try
> just that piece before a trip. Curious whether this is a problem other
> people here actually have, or if most of you have a system that
> already works.
>
> _Before posting: confirm current flair requirements and self-promotion
> rules for this sub — I couldn't verify the exact sidebar text for this
> draft._

---

## 4. How to post — what's needed before either of us can post anything

I did **not** create any account and did **not** post anything, anywhere,
while preparing this. Here's exactly what's needed before this content can
go live:

**Product Hunt**

- A Product Hunt maker account (email signup + email verification).
- Existing PH activity (following other makers, upvoting/commenting) isn't
  required to post, but a completely fresh account with zero history tends
  to get less initial visibility — worth a few days of ordinary PH use
  first if there's time.
- Gallery images have to actually be captured/designed — I can specify what
  each should show (§1 above) but can't generate them. Screenshots from the
  live app, or lightly designed versions of them, both work.
- A launch is typically scheduled for a specific day; PH's convention is a
  12:01am Pacific launch so it has the full day to gather votes.

**Hacker News**

- An HN account (username + password via news.ycombinator.com/login —
  account creation is lightweight, no mandatory email verification to
  post, though adding an email is recommended for account recovery).
- No minimum karma is required to submit a Show HN. New accounts don't get
  any visibility penalty specifically, but a post's fate is mostly decided
  by early upvotes in the first hour, so posting during active hours
  matters more than account age. Best-documented window: weekday
  9am–12pm Pacific.

**Reddit**

- A Reddit account for whichever subreddit(s) get used.
- I could **not** confirm minimum karma or account-age thresholds for
  r/houseplants, r/IndoorGarden, or r/SideProject specifically — many
  subreddits (plant ones especially) run Automod rules that silently
  remove posts from new/low-karma accounts, sometimes without any visible
  notice to the poster. If the posting account is new or low-karma,
  check for this before assuming a post that doesn't show up was just
  ignored rather than auto-removed.
- Each subreddit's current rules should get a final human read
  immediately before posting — see the verification-limits note in §3.

Nothing else in this repo needs to change to post this content; it's just
copy. The screens named in §1's gallery-image list already exist and can be
screenshotted directly from familygreenhouse.net or a local dev build.
