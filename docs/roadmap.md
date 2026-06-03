# Product roadmap

A three-year arc, by quarter. The first year is concrete; year two is shaped but not committed; year three is themes only — quarter-level planning that far out is fiction. Re-plan every quarter.

## North star

People in households share plant care without anyone feeling like a nag, and plants thrive because the right person remembers at the right time.

We measure ourselves on:

- **Plant survival rate** in active households (target: ≥95% of plants alive 90 days after creation)
- **Tasks completed within 24 hours of due** (target: ≥75%)
- **Active members per household** (target: ≥1.5; <1.5 means we're a single-user app pretending to be collaborative)

Vanity metrics like signups, MAU, and ARR are watched but not steered against.

---

## Year 1 — "Make it work, make it shareable"

The collaborative loop has to feel obvious before any expansion makes sense.

### Y1Q1 — Stabilize + grow shareability ✅

- ✅ Finished: auth, household, plants, tasks, photos, identification, billing, notifications (browser/email/SMS), preferences, i18n foundation, landing page, brand mark
- ✅ **Recurring task templates** — `models/taskTemplates.ts` with 6 curated bundles, `POST /plants/:id/apply-template`
- ✅ **Plant tags / categories** — free-form tags persisted on every plant
- ⏸ **Per-PR preview environments** — deferred (deploy infra, not codable). See `production-checklist.md`

### Y1Q2 — Care quality ✅

- ✅ **Plant photo timeline** — `appendPlantPhoto` + `getPlantPhotos` + `PhotoTimeline` component. Atomic transact-write keeps the primary `imageUrl` and the timeline in sync.
- ✅ **Watering log with notes** — completion records carry `notes`; complete-task endpoint accepts notes
- ✅ **Tap-to-snooze options** — `<details>` popover with 1d/3d/1w/skip-cycle; skip-cycle uses task's frequency
- ⏸ **Sentry + dashboards live** — code-side stubs honor `SENTRY_DSN`; flipping it on requires creating the actual Sentry project + provisioning CloudWatch dashboards in Terraform

### Y1Q3 — Growth + retention ✅

- ✅ **Welcome flow** — 3-step `WelcomeFlow` after first household creation; `welcomeSeen` persisted so it never shows twice
- ⏸ **Household payment splits** — Stripe doesn't support multi-payer subscriptions natively; a custom design we haven't done. Deferred until usage data justifies.
- ✅ **Streaks** — `computeStreak` walks the completion log with 1.5× frequency slack, displays "🌱 N-cycle … streak" on each task ≥2
- ✅ **Performance budget enforcement** — `size-limit` config + new `bundle-size` job in CI

### Y1Q4 — Reach (mostly deferred — needs external services)

- ⏸ **Plant species database integration** — Plant.id adapter already in code for _identification_. The "pre-fill care frequencies" piece needs Trefle (or Plant.id pro tier) — also legal review of redistributing botanical data. Deferred.
- ⏸ **Localized markets (Arabic + RTL)** — RTL infrastructure ready (`RTL_LANGS` set, `dir` applied). Adding Arabic = drop a translation file + entry to `RTL_LANGS`; needs a translator.
- ⏸ **Mobile app via Capacitor** — separate build pipeline + App Store / Play Store accounts. Not codable in this repo.
- ✅ **Smart reminders DND window** — `dndStart`/`dndEnd`/`timezone` on `NotificationPreferences`; `isInDndWindow` is timezone-aware and handles wrap-past-midnight. Notifier respects DND for email + SMS (browser push left to OS).

---

## Year 2 — "Make it knowledgeable"

The quality of advice the app gives goes from "you told us 7 days" to "based on this species and your region's humidity."

### Y2Q1 — Per-plant intelligence

- ✅ **Care guidance by species** — Perenual integration (Phases 0–6). Async species autocomplete merged with the static catalog, suggested watering schedules at plant creation, long-form care guides on the plant detail page, image fallback to species thumbnails, opt-in seasonal pest alerts. Feature-gated by `PERENUAL_API_KEY`. See `docs/perenual.md`.
- ✅ **Profile name editing** — `PATCH /auth/me` updates Cognito `name` and fans out across HouseholdMember rows. See `docs/profile.md`.
- ✅ **Local climate awareness** — OpenWeatherMap-backed; per-household location storage, cached weather snapshots, derived care tips (humidity/freeze/heat/rain), dashboard ClimateCard. Feature-gated by `OPENWEATHER_API_KEY`. See `docs/climate.md`.

### Y2Q2 — Insights ✅ _(year-in-review aggregation in code)_

- ✅ **Care analytics dashboards** — KPI tiles (active plants, tasks, last-7-day completions, currently-overdue), 30-day trend with 7-day moving average overlay, by-task-type breakdown, plants-at-risk ranked by max days overdue, per-member contributions. Pure SVG/CSS — no charting library dependency.
- ✅ **Year-in-review** — `getYearInReview` aggregates completions by member, type, and plant for any given year; `GET /households/:id/year-in-review`, surfaced as the `YearInReviewCard` on the dashboard (KPI tiles + by-task-type bar chart, hidden when there are no completions). The end-of-year _recap email_ is the remaining follow-on (needs the EventBridge schedule in `production-checklist.md`).

### Y2Q3 — Multi-household _(deferred — schema migration)_

- ✅ **Multi-household per user** — users can create or join additional households without losing their default. JWT default stays on the first household; the switcher pins per-request via `X-Household-Id`. See `docs/multi-household.md`.

### Y2Q4 — Open APIs + integrations _(deferred — design + infra)_

- 🟡 **Public API** — shipped read-only: key auth (`fg_` keys, Greenhouse-gated), two-layer rate limiting, and per-key least-privilege **scopes** (`read:plants`/`read:tasks`/`read:activity`), documented in `docs/public-api.md`. **Remaining gate for GA:** OAuth for third-party apps acting on a user's behalf, and a decision on write access. Until then it covers first-party scripts/integrations.
- ⏸ **Home Assistant + HealthKit** — integration platforms; out of scope for this repo until there's customer demand. (Unblocked on our side by the read API above — a Home Assistant REST sensor can already poll `/api/v1/*` with a `read:plants`-scoped key.)

---

## Near-term backlog — next-quarter candidates

Concrete, in-repo bets sized to the roadmap's principles (smallest thing that
proves value; each tied to a North-star metric; why stated, not just what).
These are the realistic "next" after the deferred Y1–Y2 items, most of which
are blocked on external services, paid APIs, translator content, or infra —
not on code. Ordered by value × cheapness.

- **End-of-year recap email** — _why:_ retention drops after the novelty
  fades; a once-a-year "here's the care your household did" recap is a cheap,
  delightful re-engagement nudge, and the data already exists. The
  `YearInReviewCard` UI is live; the recap reuses `getYearInReview`, renders to
  text/HTML, and ships via the existing `notifier` (which already degrades to a
  structured log line without SES). The only non-code piece is the annual
  EventBridge trigger (already tracked in `production-checklist.md`); a
  manual/admin "send me a preview" path is codeable today.
- **CSV / JSON import** — _why:_ the data-export path exists (`GET /me/export`
  - CSV), but the highest-friction onboarding moment is a new household with a
    dozen plants already tracked in a spreadsheet. A bulk importer (validate →
    preview → commit, reusing the plant zod schema and plan caps) directly lifts
    activation. Pure code; mirrors the export we already ship.
- **Plant archive (soft delete)** — _why:_ `deletePlant` hard-deletes and
  cascades (now including S3 images). A plant that died or was gifted away
  shouldn't force the user to choose between a cluttered grid and erasing its
  history — and hard deletes quietly corrupt the **plant-survival** North-star
  metric (a removed plant looks the same as one that never existed). Add an
  `archivedAt` flag, hide archived plants by default, keep their history, and
  reserve hard delete for true erasure.
- **Weekly "plants at risk" digest (opt-in)** — _why:_ this is the
  plant-survival metric turned into action. The analytics layer already ranks
  plants-at-risk by max days overdue; surfacing the top few in an opt-in weekly
  email/push closes the loop from "we can see the risk" to "the right person is
  nudged before the plant dies." Reuses existing analytics + notification
  prefs (respects the DND window already built).
- **Public API: write access + OAuth (the GA gate)** — _why:_ the read API now
  ships with scopes, rate limits, and docs (`docs/public-api.md`); the promised
  "automate your plant care" story needs writes (complete a task, add a plant)
  and a real third-party auth model. This is the design-heavy item gating GA —
  scoped here so it isn't lost: design OAuth (authorization-code + PKCE),
  add `write:*` scopes alongside the existing `read:*`, and decide the consent
  surface. Until then, first-party key auth stands.

## Year 3 — themes only

Far enough out that quarter-level commitments are imaginary. The themes:

- **Plant identification accuracy**: build our own model fine-tuned on customer photos (with explicit consent), instead of paying per Plant.id call.
- **Computer vision health detection**: from a photo, flag yellowing / overwatering / pests. Cosmetic-grade only, never diagnostic.
- **Marketplace + community**: not Reddit-replacement, but lightweight sharing of "what's growing in your house?" and trading cuttings within trusted networks.
- **B2B**: greenhouses + nurseries selling plants ship them with a pre-filled care plan that imports into the buyer's Family Greenhouse household.
- **Sustainability angle**: rough water/energy footprint per plant; trade tips on low-water care.

---

## Roadmap principles

- **Default no.** Most ideas get rejected. Each "yes" closes a future "yes."
- **Plant survival is the headline metric.** Anything that doesn't move it is a tool, not a goal.
- **Build the smallest thing that proves the value, then iterate.** Recurring task templates is one screen and a JSON file, not a "templating engine."
- **Honesty in marketing.** No claims we can't back with data — testimonials hidden behind a flag until they're real, no claimed user counts on the landing page until we have them.
- **Costs grow with users, not with quarters.** Every new external dependency (a new API, a new SaaS) needs an answer to "what does this cost at 1,000 households?"
- **Document why, not just what.** A roadmap that says "build streaks" is useless; "build streaks because retention drops 40% after week 2 and gentle nudges in similar apps lifted it 15%" is workable.

## Relationship to the production checklist

The [`production-checklist.md`](production-checklist.md) is a per-launch gating list. The roadmap is what we build _with_ the launched system. They overlap where roadmap items pull in new infrastructure (e.g. Y1Q2 monitoring dashboards are also a checklist item).

When a roadmap item lands, mark its corresponding checklist item resolved and add the next one (e.g. Y1Q4 Capacitor wrapper introduces native-app review processes that need their own checklist).
