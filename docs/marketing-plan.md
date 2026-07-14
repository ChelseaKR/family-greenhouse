# Marketing & distribution plan — historical hypotheses

> **Commercial activity hold — July 14, 2026.** This is an unexecuted planning
> artifact, not an active launch, outreach, acquisition, signup, customer, or
> revenue program. Do not perform the activities below while
> [`COMMERCIAL-STATUS.md`](./COMMERCIAL-STATUS.md) remains in effect.

A realistic, executable go-to-market plan for one person (you) with Claude as a force multiplier. The goal is **100 active households in 6 months**, not viral growth — that's the threshold where the strategy review's empirical questions become answerable.

This isn't a plan that needs a marketing hire; it's a plan that one focused person can execute in ~10 hours/week.

---

## The honest constraints

- **One person.** Time is the limiting resource. Anything that requires coordinating with other humans (partnerships, podcast tours, conference talks) is expensive.
- **Small budget.** Treat anything over $200/month as a deliberate experiment with a kill-switch date, not an ongoing line item.
- **No existing audience.** No newsletter, no Twitter following, no email list. We start from zero.
- **Niche is real but quiet.** "Couples and roommates who share plant care" is a real audience; it's also not searching for us. Most of them don't know they want this.
- **Claude is unusually good at content production.** Drafting, editing, research, code generation for landing variants, repackaging, translation. Lean into this — it's the structural advantage.

---

## The single-question funnel

Every marketing decision answers one question: **does this get someone to land on the site, sign up, and add a plant?** Track in PostHog (`docs/analytics.md`). If a channel doesn't move that funnel after 4 weeks, kill it.

---

## Channel ranking (next 6 months)

Ranked by likely impact × what one person can actually sustain.

### Tier A — start here

#### 1. SEO content for "I should write down what plants need" intent

**Why:** This is the only channel with compounding returns where one person + Claude can match the output of a small content team. Every published article keeps earning traffic indefinitely.

**Targets (real long-tail queries with clear intent):**

- _"how to remember to water plants"_ (~3K/mo)
- _"plant watering schedule template"_ (~1K/mo)
- _"shared plant care app for couples"_ (~200/mo, very high intent)
- _"how often to water [common houseplant]"_ — programmatic landing pages, one per species
- _"plant died because I forgot"_ — emotional searcher, perfect ICP

**Cadence:** One long-form (1500–2500 word) article per week. Claude drafts; you edit, fact-check, add personal voice. Two species programmatic pages per week (template + Perenual data → 200-word landing). Total time: ~5 hours/week.

**Distribution:** No SEO tooling subscription — start with Google Search Console (free) + a basic site map. Add basic schema markup (FAQ, Article, HowTo). Publish on a `/blog` route in the same domain to keep authority concentrated.

**Honest expectation:** Real traffic by month 4–5. Don't expect anything in the first 3 months and don't kill it during that window.

#### 2. Reddit, but as a real participant

**Why:** Reddit ranks well in Google, the audience self-selects (subscribers of r/houseplants are exactly our ICP), and one good comment thread can drive real signups.

**Subreddits to participate in:**

- r/houseplants (3M+)
- r/plantclinic (250K+)
- r/IndoorGarden
- r/UrbanGardening
- r/AskMen / r/AskWomen — when "shared chores" threads come up

**Rules:**

- Comment 80%, post 20%. Reddit despises self-promo.
- Build the account to ~500 karma before mentioning the product. _Earned_ mentions only.
- When you do mention the app, be specific: "I built this because of X. It might help if Y. Here's the link, no signup required to see how it works."
- One product mention per week, max.

**Time:** 30 min/day if you enjoy it; less if you don't. **If it feels like a chore, stop** — performative Reddit participation is worse than no Reddit presence.

#### 3. The pre-launch landing page list

**Why:** Lets you collect interest before features are perfect, and gives you a warm audience for launch.

**What to build (1 day):**

- A `/early-access` page with a single email field and one paragraph.
- Welcome email confirming, then nothing for 4 weeks.
- Then: a real launch email with a personal note + signup link.

**Goal:** 100–500 emails before "official launch." Even if conversion is bad (~20%), that's 20–100 households on day one — more than enough signal.

**Tools:** ConvertKit (free up to 1,000 subscribers) or Buttondown ($9/mo, simpler).

### Tier B — if Tier A is working

#### 4. Y Combinator's Hacker News (Show HN)

**Why:** One well-written Show HN can drive 5,000+ landing-page visits in a day. The audience converts at low rates but is influential and writes about what they discover.

**When:** After 6+ weeks of polish, when the app is genuinely demo-ready and the funnel is instrumented. Not before.

**What to write:** A 200-word "Show HN: Family Greenhouse — collaborative plant care that finally solves 'I thought you watered it'" with screenshots. **Be honest about the stage** ("solo-built, beta, would love feedback").

**Tuesday or Wednesday at 10am ET.** Other times the front page is dominated by funded companies.

**Risk:** HN is mood-dependent. A great product can flop on a slow news day. Treat as a one-shot experiment with a write-up of what happened, not a pillar.

#### 5. Product Hunt launch

**Why:** Lower-quality traffic than HN but better for a niche product because the audience is non-technical "I love new apps" types — closer to our actual ICP.

**Timing:** 4–6 weeks after public launch. Coordinate with the email list (ask early-access users to upvote that morning).

**Prep work:**

- Tagline: "Collaborative plant care for households" (don't be cute)
- Gallery: 5 screenshots, each with a one-sentence caption
- A short founder note (Claude can draft; you rewrite for voice)

**Honest expectation:** ~500 visits, ~20 signups, ~5 active households a week later if the product holds up.

#### 6. Twitter/X (only if you'd enjoy it)

**Why:** "Build in public" still works for nerdy products. Sharing screenshots, dev notes, and "things I learned" can build a small but loyal audience.

**Cadence:** If you'd post 2–3 times a week happily, do it. If it'd be a slog, skip — performative building is more damage than help.

### Tier C — explicitly skip

- **Google Ads.** $5 CPC × 5% landing conversion = $100 per signup, dead on arrival.
- **Facebook/Instagram Ads.** Same math, plus the audience targeting for "people who share plant care" is bad.
- **Influencer outreach.** Unscalable, expensive, and feels icky for a beta product.
- **TikTok.** The plant TikTok community is real, but breaking in cold is a ~50hr/week commitment we can't make.
- **Conference talks / sponsorships.** Months of prep, not the right stage of company.

---

## Content + production with Claude

This is where being one person stops being a constraint.

### The article production pipeline

Goal: one article + two programmatic pages per week, ~5 hours of human time.

1. **Topic discovery** (15 min): Claude generates 20 long-tail search queries from a seed phrase. You pick one.
2. **Outline** (15 min): Claude drafts a 7-section outline. You add personal angle, kill the generic sections.
3. **Draft** (30 min): Claude writes ~2000 words. The draft will be 70% there; the rest is voice.
4. **Edit** (90 min): You rewrite the intro and conclusion. Cut 30% of the body. Add your own opinion / contrarian take. **This is where the article earns its keep** — Claude-perfect content reads like every other AI blog and ranks worse than human-edited content.
5. **Visuals** (30 min): One hero image (Unsplash, attributed) + 2–3 simple SVG diagrams (Claude generates the SVG; you tweak in browser).
6. **Schema + meta** (15 min): Claude generates the JSON-LD; you paste it.
7. **Publish + share** (15 min): Push to the blog, post to one relevant subreddit if directly useful, schedule a tweet.

**Total:** ~3.5 hours. The remaining 1.5 hours go to the two programmatic pages (mostly template-driven).

### Specific Claude prompts that work

For each phase of content work, a tight prompt template:

- **Topic discovery:** _"Give me 20 long-tail search queries that someone who has ever forgotten to water a houseplant might type. Skip generic 'how to care for X' — I want emotional or situational queries with clear intent."_
- **Outline:** _"Outline a 2000-word article for the query 'X'. Include 7 sections, a contrarian angle, two specific examples with real plant names, and a tight conclusion. Skip filler sections like 'introduction' and 'why this matters'."_
- **Draft:** _"Write a 2000-word draft from the outline above. Use a personal voice — 'I' and 'my' are fine. Avoid AI tells: no 'in today's world', no 'embark on a journey', no 'unlock'. Specific over abstract. Short paragraphs."_
- **Editing pass:** _"Read the following draft and tell me three things to cut, one place where the voice sounds fake, and one section that needs a human anecdote."_

### Repurposing

Every article should fan out into:

- A 2-tweet summary (Claude drafts; post the next day)
- One paragraph for the email newsletter (Claude drafts; you publish biweekly)
- One Reddit comment when relevant (don't link — drop the value, link only if asked)
- One landing-page snippet ("People who liked this also bought…" cross-link block)

Claude can do all four from the same draft in one prompt.

---

## The launch sequence

Concrete timeline for the next 6 months. Adjust as signal arrives.

### Month 1 — Foundation

- ✅ PostHog wired up (already done — `docs/analytics.md`)
- ✅ Production funnel events firing
- Set up Google Search Console + sitemap
- Set up early-access email list (ConvertKit / Buttondown)
- Write 4 pillar articles (the "if I only had four pages, what would they be" set)
- Build `/blog` route in the SPA (route + a markdown loader is a half-day's work)

**End-of-month checkpoint:** 4 articles published, email list at 50, no signups expected yet.

### Month 2 — Content velocity

- 4 more articles (now you have 8 — enough to start cross-linking)
- 8 programmatic species pages
- Begin Reddit participation (no product mentions yet)
- First small experiment: a single post on r/houseplants saying "I'm building a shared plant care app, here's my early-access list" — measure the signal

**End-of-month checkpoint:** 12 articles, email list at 100, first 5–10 signups from early-access.

### Month 3 — Real launch

- Hacker News Show HN (Tuesday morning)
- Email all early-access subscribers same day
- Live-tweet the launch if you do Twitter
- 4 more articles (don't slow down — content is the long game)

**End-of-month checkpoint:** 100+ signups, 20+ active households (≥1 task completed).

### Month 4 — Listen

- Read every signup. Email each user a personal note within 48 hours: "What made you sign up? What's working? What's broken?"
- Use the answers to prioritize the next month's product work.
- Continue weekly content cadence.

**End-of-month checkpoint:** Real product feedback loop running.

### Month 5 — Iterate based on data

- Build the highest-leverage thing the user research surfaced.
- Product Hunt launch if you didn't already.
- A/B test one pricing change (the strategy doc's open question).

### Month 6 — Re-plan

By now you'll have data. The plan from month 7 forward should be re-derived from what you've learned, not from this document.

---

## The leverage Claude gives you specifically

| Where one founder usually struggles | What Claude makes possible                                |
| ----------------------------------- | --------------------------------------------------------- |
| Content production volume           | One article/week becomes feasible solo                    |
| SEO research                        | Long-tail keyword discovery without an Ahrefs sub         |
| Customer-research synthesis         | Dump 20 user emails, get a thematic summary in one prompt |
| Landing-page copy variants          | A/B testable headlines in minutes                         |
| Translation when localization lands | Bootstrap Spanish + Portuguese without a translator       |
| Schema / structured data            | Generate JSON-LD without learning the spec                |
| Diagram + illustration              | SVG illustrations like the empty-state ones in this repo  |
| Customer-support email triage       | Pre-draft replies for review                              |

The pattern across all of these: **Claude gets you 70% of the way; you do the 30% that makes it sound like a person**. That ratio is the structural advantage.

---

## What success looks like, honestly

By month 6:

- 100+ active households (≥1 task completed in the last 30 days)
- ~30 articles indexed, 5 ranking on page 1 for their target query
- Email list of 500–1500
- Conversion data sufficient to answer the strategy doc's open questions about pricing
- A clear sense of which channel deserves doubling down and which to cut

**What success doesn't look like:**

- Going viral. Don't bet on it. Plan for the steady-state version.
- A perfect product. Six months in, the product should be visibly improving from user feedback, not from the founder's pre-imagined roadmap.
- Pivoting. The strategy review's hypotheses are testable; six months is enough to validate or kill them, not enough to credibly pivot.

---

## What this plan does NOT cover

- **Hiring.** Not in scope at this stage. If month 6 metrics are strong, the first hire is probably a contractor for content, not full-time anything.
- **Funding.** Same. The plan is structurally bootstrappable. If a strategic angel offers help, fine, but don't optimize for fundability.
- **Brand work.** The visual identity, brand mark, and design system are good enough. Don't burn cycles on a rebrand until you have evidence the current brand is hurting conversion.
- **Press.** Generic "tech press" coverage rarely moves the needle for a household-niche app. If a niche outlet (a plant-care YouTuber, a couples' lifestyle blog) reaches out, take the meeting; don't pursue cold.

---

## Tell-yourself check

Before any marketing decision, three honest questions:

1. **Will I still be doing this in 8 weeks?** If not, don't start. Channels that get abandoned are worse than channels never tried.
2. **Does this answer the funnel question?** If yes, prioritize. If not, it's craft for craft's sake.
3. **What would I be doing instead?** Time has the highest opportunity cost of any input. The best marketing channel is the one you'd genuinely enjoy sustaining.

If you can't answer all three honestly, do something else.
