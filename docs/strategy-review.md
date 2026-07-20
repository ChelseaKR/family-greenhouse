# Family Greenhouse — product & strategy review

A frank look at where the product stands, what the engineering work has earned us, what's missing, and where the next six months should focus.

This doc is opinionated. Treat it as one informed read, not the only one.

> Last reconciled with the shipped product: 2026-07-13.

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

- More than 1,100 backend tests, 400 frontend tests, and a 100-test Playwright
  browser suite running in CI.
- API spec drift guarded by a CI script that diffs handler comments against the OpenAPI doc.
- Every external integration returns `null` on failure rather than throwing — the app stays usable when Perenual, Plant.id, or OpenWeatherMap is down.
- DDB-backed caches with TTLs and daily-budget circuit breakers for both external APIs.
- X-Ray active tracing on Lambda; X-Ray trace id correlated into structured logs.
- Six-panel CloudWatch dashboard (request rate, 4XX/5XX split, p95 latency, DDB throttles, Lambda errors, Perenual budget).
- Per-user rate limiting on write endpoints; per-IP on auth.
- WCAG 2.2 AA accessibility validated.

### Honest gaps

- DynamoDB PITR and a successful restore drill cover backup recovery, but a
  regional outage still takes down the single-region stack.
- Spanish catalogs have complete key coverage; the locale remains gated until
  native-speaker review. Arabic/RTL content still requires a translator.
- No real production data yet. Every dashboard, every chart, every metric we track is theoretical until users show up.
- Capacitor iOS/Android shells, store assets, and validation are shipped; store
  accounts, signing credentials, physical-device checks, and submission are
  external release gates.
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

### Marketing surface is thin

Landing page is competent and the first set of care articles is live, but the
content surface is still thin and has no proven search distribution. The
audience for "shared plant care" is the kind that searches for solutions
("how do I get my partner to water the plants") — consistent publishing and
measurement remain high-leverage.

### The species database is a leaky abstraction

Perenual is great when the user picks a species we recognize. Free-text plants
still receive less enrichment, but the product now says so explicitly through
`NoCareDataNotice` instead of failing as a blank card. The remaining product
question is whether that explanation is enough or whether we need a manual
species-match correction flow.

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

### 1. Pick one external integration and double down (Q2)

Perenual is the obvious one. The integration is shipped; deepen it: real-time pest pressure (not just seasonal), region-specific watering modifiers (combine climate + species), a "compare your care to species recommendations" report. Don't add a fourth integration — sharpen the one that matters.

### 2. Mobile (Q2/Q3)

Capacitor wrapper around the SPA is the cheapest path. The PWA already works on mobile browsers. Native is a discoverability play (App Store presence) more than a UX one. Budget: 4 weeks of engineering + 2 weeks of App Store / Play Store administrivia.

### 3. The notification dispatcher needs real-world battle testing (Q1, in parallel)

Not a feature — quality work. End-to-end test the full pipeline at varied user counts, varied DND windows, varied timezones. Add chaos: what happens when SES is rate-limited mid-batch? Today we don't know.

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
- The audience that searches for plant care is reachable via SEO + organic content. (Probably true. Test in Q1.)
- Customer support volume stays low because the product is mostly self-serve. (Possible if we keep the surface area honest.)

If any of these turns out to be false, the strategy needs to flex.

---

## A note on craft

The engineering investment here has been disciplined. Every external integration is gated and degrades cleanly. Every endpoint has structured logging. Every cache has a TTL and a budget. The code reads as if someone is going to maintain it for a decade.

That discipline is the right bet only if the product survives long enough to need it. The forcing function for the next quarter is _getting customers_, not adding more craft. Resist the pull toward another phase of the Perenual roadmap, another infrastructure module, another quality audit. The work is good; the next thing it needs is a user.
