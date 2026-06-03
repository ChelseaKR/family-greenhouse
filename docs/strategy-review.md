# Family Greenhouse — product & strategy review

A frank look at where the product stands, what the engineering work has earned us, what's missing, and where the next six months should focus.

This doc is opinionated. Treat it as one informed read, not the only one.

---

## What we've actually built

A short, honest inventory of the product surface today.

### Core loop (strong)

Adding a plant, scheduling tasks, sharing the load with housemates, completing tasks, watching the streak — this loop works end-to-end. The collaborative angle is real, not a tagline:

- Multi-member households with admin/member roles, invite links, member rosters.
- Multi-household per user (each home, each role), with a switcher that pins requests via `X-Household-Id`.
- Tasks carry assignee, frequency, snooze, completion notes, and streak tracking.
- Activity feed makes "who watered what when" visible across the household.

### Smart layer (shipped, gated)

Two real external integrations that meaningfully upgrade the experience without forcing dependency on them:

- **Perenual** (species data) — autocomplete from a 10K-plant catalog, suggested watering schedules at plant creation, long-form care guides on the plant detail page, image fallbacks, opt-in seasonal pest alerts. Feature-gated via `PERENUAL_API_KEY`. With the key off, the static 245-entry catalog still drives autocomplete; everything else degrades cleanly.
- **OpenWeatherMap** (climate awareness) — per-household location, derived care tips (humidity warnings, freeze alerts, "skip watering today" on rainy days, hot-day reminders). Feature-gated via `OPENWEATHER_API_KEY`.

The architecture is consistent across both: raw client → cache + budget gate → handler → frontend service. Adding a third provider (or swapping one out) is a one-file change.

### Insight surfaces (shipped)

- Analytics page with KPI tiles, 30-day trend + 7-day moving average, by-task-type breakdown, plants-at-risk, per-member contribution.
- Year-in-review aggregation surfaced on the dashboard.
- Plant identification via Plant.id with auto-resolution to Perenual species ids.
- Photo timeline per plant (atomic transact-write keeps the gallery and primary photo in sync).

### Operational maturity (strong)

- 243 backend + 104 frontend tests + a Playwright e2e suite running in CI.
- API spec drift guarded by a CI script that diffs handler comments against the OpenAPI doc.
- Every external integration returns `null` on failure rather than throwing — the app stays usable when Perenual, Plant.id, or OpenWeatherMap is down.
- DDB-backed caches with TTLs and daily-budget circuit breakers for both external APIs.
- X-Ray active tracing on Lambda; X-Ray trace id correlated into structured logs.
- Six-panel CloudWatch dashboard (request rate, 4XX/5XX split, p95 latency, DDB throttles, Lambda errors, Perenual budget).
- Per-user rate limiting on write endpoints; per-IP on auth.
- WCAG 2.2 AA accessibility validated.

### Honest gaps

- DR rehearsal not done. PITR config needs to be verified before launch.
- Localization is structurally ready but content-empty. Picker is now flag-gated to English until translations land.
- No real production data yet. Every dashboard, every chart, every metric we track is theoretical until users show up.
- Mobile app deferred (Capacitor wrapper noted in roadmap as separate pipeline work).
- Stripe-handled billing live but customer subscription splits across household members deferred (would need custom design).

---

## Strengths

### The collaboration story is genuinely differentiated

Every plant care app on the market is built for one user. We've spent real engineering on the case where four roommates need to coordinate watering without anyone feeling like the nag. The activity feed, member roster, role-aware permissions, and "who's the most-overdue plant pointed at" data — none of those exist in single-user apps. This is a moat if we lean into it.

### Engineering quality is well above stage-appropriate

For a beta product, the operational discipline (typed schemas, strict request validation, audit logging, structured failure modes, observability dashboards, drift-guarded API spec) is what you'd expect from a Series-A team a year in. That's a deliberate investment that will pay back in maintainability and hiring.

### Brand voice is consistent

The Joyce dedication in the footer, the "in loving memory" line, the gentle copy ("the right person remembers at the right time"), the warm color palette — these read as care, not productivity-app aggression. The tone is recognizable.

---

## Weaknesses

### We have no users yet

Every "what should we do next" decision is being made without telemetry. The roadmap is opinionated, but it's opinion based on craft instincts, not signal. The first 50 active households will reorder the priority list more than any internal review can.

### The free tier is generous to the point of customer-hostile to ourselves

10 plants free with no card on file is unusually generous. That's a deliberate growth bet, but it should be tested — does dropping to 5 plants change conversion? Does requiring a card at signup (with a no-charge first month) reduce signups by 20% or 70%? We don't know. **The pricing page is a guess.**

### Marketing surface is thin

Landing page is competent. The blog/content surface is empty. SEO presence is essentially zero. The audience for "shared plant care" is the kind that searches for solutions ("how do I get my partner to water the plants") — content marketing here is high-leverage and we haven't started.

### The species database is a leaky abstraction

Perenual is great when the user picks a species we recognize. When they don't (free-text "the funky one Aunt Ruth gave me"), the app silently downgrades — no care guide, no auto-watering suggestion, no climate filter applies. Users may not realize they're missing features by typing a name we don't know. We should surface this gap more honestly in the UI ("we don't have care data for this species — care guide hidden").

### Notification UX hasn't been load-tested

DND windows, per-channel opt-in, browser/email/SMS, pest alerts on top — the surface area is large and the failure modes (notification at 3am because timezone math went wrong) are exactly the kind that get a one-star App Store review. We have unit tests for `isInDndWindow` but no real end-to-end test of the full notification dispatcher running over varied user prefs.

---

## Threats

### Trefle déjà vu

We took a hard dependency on Perenual via a clean adapter. Perenual is small, has had quality fluctuations, and could disappear or change pricing aggressively. Mitigation in place: (1) feature gate so the app works without it, (2) the static fallback catalog, (3) the layering means swapping providers is one file. But we should evaluate at least one fallback (Trefle if it's stable, or a manual curation pipeline) before our user base depends on the smart layer.

### AWS lock-in is real

Cognito, DDB, S3, SES, SNS, Lambda, CloudFront, X-Ray — every layer is AWS. Migrating off is months. This is the right trade for our cost structure today, but it's a constraint to be aware of when negotiating with a future enterprise customer who has a multi-cloud requirement.

### Stripe captures our pricing

Stripe is the obvious choice and works well, but the payment-splits feature we'd want for households (everyone chips in) doesn't exist natively. We've deferred it — that's correct — but if we want to ship it, we'll be building substantial bespoke logic on top of Stripe primitives.

### "Plant care" has a discovery problem

People who need this app don't know they need it until their second dead plant. The funnel is "I should keep track of this" → google → maybe land here. Content marketing helps; product placement (a partnership with a plant retailer) helps more; but neither is in motion. **We are downstream of dead plants.**

---

## Where the next 6 months should go

Honest priorities, ranked.

### 1. Get to 100 active households (Quarter 1)

Nothing else matters more. This is product-market-fit signal, not vanity. We need real telemetry on:

- Where users churn in the funnel
- Whether the collaborative loop actually triggers (do households end up with >1 active member?)
- Which pricing tier actually converts
- What features users use vs. which we built and they ignore

The product is ready enough. The marketing isn't. **Spend Q1 on content + SEO + a small paid-acquisition experiment, not on more features.**

### 2. Pick one external integration and double down (Q2)

Perenual is the obvious one. The integration is shipped; deepen it: real-time pest pressure (not just seasonal), region-specific watering modifiers (combine climate + species), a "compare your care to species recommendations" report. Don't add a fourth integration — sharpen the one that matters.

### 3. Mobile (Q2/Q3)

Capacitor wrapper around the SPA is the cheapest path. The PWA already works on mobile browsers. Native is a discoverability play (App Store presence) more than a UX one. Budget: 4 weeks of engineering + 2 weeks of App Store / Play Store administrivia.

### 4. The notification dispatcher needs real-world battle testing (Q1, in parallel)

Not a feature — quality work. End-to-end test the full pipeline at varied user counts, varied DND windows, varied timezones. Add chaos: what happens when SES is rate-limited mid-batch? Today we don't know.

### 5. Honest pricing experiment (Q2)

We will not know if the current pricing tiers are right until we A/B test them. Even a small experiment ("require card at signup, no charge for 14 days" vs. "fully free up to 10") will move our understanding of the funnel more than another month of polish.

---

## What we should _not_ do next

- **Build a fourth external integration.** Perenual + Plant.id + OpenWeatherMap is enough until we have signal that any of them is undervalued.
- **Computer vision health detection.** Cool, expensive, year 3 theme. Don't get drawn in early.
- **A marketplace / community feature.** Network effects are great but adding social to a 0-user product is fantasy.
- **Re-platform the frontend.** React + Vite + TanStack Query is fine; nothing about scaling will be easier on a different stack right now.
- **Multi-region DDB.** Not until a customer with a regional SLA asks.

---

## What needs to be true for this to work

The product strategy implicitly assumes:

- Households of 2–4 people are willing to install a shared app for plant care. (Plausible. Untested.)
- The "right person reminded at the right time" is the differentiator, not the species database. (Likely true. The smart layer is a moat-deepener, not the moat.)
- Free → paid conversion at the 10-plant boundary is real. (Genuinely unknown. **Highest-priority empirical question.**)
- The audience that searches for plant care is reachable via SEO + organic content. (Probably true. Test in Q1.)
- Customer support volume stays low because the product is mostly self-serve. (Possible if we keep the surface area honest.)

If any of these turns out to be false, the strategy needs to flex. Especially #3 — if the 10-plant free tier is _too_ generous, the company doesn't survive. If it's _not generous enough_, the funnel chokes. We don't currently know which.

---

## A note on craft

The engineering investment here has been disciplined. Every external integration is gated and degrades cleanly. Every endpoint has structured logging. Every cache has a TTL and a budget. The code reads as if someone is going to maintain it for a decade.

That discipline is the right bet only if the product survives long enough to need it. The forcing function for the next quarter is _getting customers_, not adding more craft. Resist the pull toward another phase of the Perenual roadmap, another infrastructure module, another quality audit. The work is good; the next thing it needs is a user.
