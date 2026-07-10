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

- ✅ **Public API** — shipped read-only first: key auth (`fg_` keys, Greenhouse-gated), two-layer rate limiting, and per-key least-privilege **scopes** (`read:plants`/`read:tasks`/`read:activity`), documented in `docs/public-api.md`. **Write scopes shipped 2026-06-11** (complete/snooze tasks under `write:*`, with the consent warning in settings). The OAuth design (authorization-code + PKCE, consent surface) is settled in [`docs/oauth-design.md`](oauth-design.md) — implementation waits for a real third-party integrator, by design.
- ⏸ **Home Assistant + HealthKit** — integration platforms; out of scope for this repo until there's customer demand. (Unblocked on our side by the read API above — a Home Assistant REST sensor can already poll `/api/v1/*` with a `read:plants`-scoped key.)

---

## Near-term backlog — SHIPPED (2026-06-11)

This list did its job: every entry below landed, alongside a second wave of
smaller bets that grew out of them. Kept (with the original _why_ trimmed)
as the record of what shipped and why; the next backlog starts empty, per
the principles — candidates earn their way on, they don't roll over.

- ✅ **End-of-year recap email** — retention re-engagement; reuses
  `getYearInReview`, renders text/HTML, ships via the existing `notifier`.
  The annual EventBridge trigger remains tracked in
  `production-checklist.md`; the admin "send me a preview" path works today.
- ✅ **CSV / JSON import** — bulk onboarding (validate → preview → commit,
  max 100/batch, plan caps respected, partial success by contract). Mirrors
  the export we already shipped.
- ✅ **Plant lifecycle (née "plant archive")** — shipped as
  `active`/`died`/`gave_away` statuses instead of an `archivedAt` flag:
  outcomes are first-class (they feed the plant-survival metric directly),
  past plants keep their history, hard delete is reserved for true erasure.
- ✅ **Weekly "plants at risk" digest (opt-in)** — the plant-survival metric
  turned into action; reuses the analytics ranking + notification prefs and
  respects the DND window.
- ✅ **Public API: write scopes + OAuth design** — `write:*` scopes shipped
  alongside `read:*`; the OAuth model (authorization-code + PKCE, consent
  surface) is designed in [`docs/oauth-design.md`](oauth-design.md) and
  deliberately unimplemented until a real third-party integrator shows up.

### Also shipped in this wave (2026-06-11)

Smaller items that landed with the backlog, listed so the roadmap stays an
honest record:

- ✅ **Climate-skip** — "rain/frost expected — skip this cycle?" prompts on
  weather-affected tasks (Y2Q1 climate awareness turned into action).
- ✅ **Task claiming** — "up for grabs" tasks any member can claim/release;
  feeds the active-members-per-household metric directly.
- ✅ **Vacation mode** — care handoff windows with a covering member;
  reminders reroute until the window ends.
- ✅ **Phone verification** — 6-digit SMS code gate before SMS reminders can
  be enabled (deliverability + compliance posture, see `docs/runbooks.md`).
- ✅ **Chat write-proposals + streaming groundwork** — the care chatbot can
  propose a reminder (user confirms; the bot never writes directly), and the
  Bedrock streaming path is in place behind the same wrapper.
- ✅ **Identification metering (env-gated)** — per-household monthly
  Plant.id usage tracked on every call; _enforcement_ stays behind
  `IDENTIFY_METERING_ENABLED` so flipping it on is a launch decision, not a
  deploy.
- ✅ **Downgrade-overage UI** — over-plan households see exactly what keeps
  working (everything existing) and what pauses (adding more) instead of a
  surprise hard wall.
- ✅ **Propagation tracker** — cuttings link to their parent
  (`parentPlantId`), with a lineage card on the plant page.
- ✅ **Cutting share** — share a plant card snapshot household-to-household
  via a 14-day public link; accepts run through the normal plan-capped
  create.
- ✅ **Leaf-health check** — the first slice of the Year-3 CV theme, scoped
  to "is this leaf visibly yellowing/browning/spotted?": one photo → strict
  JSON assessment from Claude on Bedrock (5s timeout, 5/min cap, demo
  fallback without Bedrock access), surfaced as a dialog on the plant page.
  Cosmetic-grade only, never diagnostic — exactly the line the Y3 theme
  drew.

> **Deliberately still OFF:** the beta/monetization flip. Identification
> metering enforcement, billing enforcement beyond the existing plan caps,
> and public pricing pressure all stay dark until we choose to launch them —
> the code paths exist and are tested, the switch is a product decision.

## Year 3 — themes only

Far enough out that quarter-level commitments are imaginary. The themes:

- **Plant identification accuracy**: build our own model fine-tuned on customer photos (with explicit consent), instead of paying per Plant.id call.
- **Computer vision health detection**: from a photo, flag yellowing / overwatering / pests. Cosmetic-grade only, never diagnostic. _First slice shipped early (2026-06-11) as the leaf-health check — see "Also shipped in this wave" above; the theme's remaining scope is breadth (whole-plant, trends over the photo timeline), not a first proof._
- **Marketplace + community**: not Reddit-replacement, but lightweight sharing of "what's growing in your house?" and trading cuttings within trusted networks. _The cutting-share link shipped as the smallest proof of the trading half._
- **B2B**: greenhouses + nurseries selling plants ship them with a pre-filled care plan that imports into the buyer's Family Greenhouse household. _Design worked out in [`docs/b2b-greenhouse-mode.md`](b2b-greenhouse-mode.md) — explicitly pilot-gated: no code until a real nursery signs._
- **Sustainability angle**: rough water/energy footprint per plant; trade tips on low-water care.

---

## Roadmap principles

- **Default no.** Most ideas get rejected. Each "yes" closes a future "yes."
- **Plant survival is the headline metric.** Anything that doesn't move it is a tool, not a goal.
- **Build the smallest thing that proves the value, then iterate.** Recurring task templates is one screen and a JSON file, not a "templating engine."
- **Honesty in marketing.** No claims we can't back with data — testimonials hidden behind a flag until they're real, no claimed user counts on the landing page until we have them.
- **Costs grow with users, not with quarters.** Every new external dependency (a new API, a new SaaS) needs an answer to "what does this cost at 1,000 households?"
- **Document why, not just what.** A roadmap that says "build streaks" is useless; "build streaks because retention drops 40% after week 2 and gentle nudges in similar apps lifted it 15%" is workable.

## Metrics ledger (standards conformance — CICD-29, AIEV-01)

Per `STANDARDS/CI-CD-STANDARD.md` CICD-29, this ledger declares the optional CI pipeline stages and any AI-evaluation state — added 2026-07-05 as part of the conformance-audit remediation (the pipeline itself predates this declaration; see `README.md` "Standards conformance" for the full per-standard table).

**Pipeline stage declarations** (`ci.yml`'s 10 jobs, stages 6–8 are the "optional, declare or N/A" tier):

| Stage                                            | Applicable?    | Status                                                                                                                                            |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–5: lint, typecheck, test×2, security-scan/SAST | Applies (core) | Green, required                                                                                                                                   |
| 6: build                                         | Applies (core) | Green, required                                                                                                                                   |
| 7: Lighthouse (perf + a11y)                      | Applies        | Green, required — now runs automatically whenever `frontend/**` changes (the `skip-lighthouse` label bypass was closed 2026-07-05; see CHANGELOG) |
| 8: bundle-size, e2e+a11y (Playwright)            | Applies        | Green, required                                                                                                                                   |
| zizmor (workflow SAST)                           | Applies        | Shipped — `.github/workflows/zizmor.yml`, results upload to code scanning                                                                         |
| CodeQL                                           | Applies        | Shipped (2026-07-05, PR #177) — `.github/workflows/codeql.yml`; repo is public so this is free                                                    |
| OpenSSF Scorecard                                | Applies        | Shipped — `.github/workflows/scorecard.yml`, publishes to the public Scorecard API + code scanning                                                |

```
AI-Evaluation-Standard: APPLIES (tiers: tool-use + RAG, citation/grounding guard, model-card)
```

See `docs/RESPONSIBLE-TECH-AUDITS.md` for the full dated waiver (expires 2026-10-05) covering what's built (starter benchmark, citation/grounding guard, model card) vs. tracked (full RAGAS-class metric suite, red-team scan, judge calibration).

**Measured values (starter eval, 2026-07-05):** see `evals/eval-baseline.json` — recall@3 = 1.0, own-chunk top-1 rate = 1.0 on a 22-question benchmark (target per the standard: 100–500 questions with live faithfulness/hallucination/refusal scoring). Silent deviation from the standard's numeric targets is itself a defect — this line is the required, explicit record of the deviation and its rationale (Node/TS stack vs. the standard's Python-oriented reference tooling; see `evals/README.md`).

## Relationship to the production checklist

The [`production-checklist.md`](production-checklist.md) is a per-launch gating list. The roadmap is what we build _with_ the launched system. They overlap where roadmap items pull in new infrastructure (e.g. Y1Q2 monitoring dashboards are also a checklist item).

When a roadmap item lands, mark its corresponding checklist item resolved and add the next one (e.g. Y1Q4 Capacitor wrapper introduces native-app review processes that need their own checklist).
