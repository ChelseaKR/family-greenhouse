# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) once it
reaches 1.0.0 (pre-1.0: minor bumps may include breaking changes — see
`docs/RESPONSIBLE-TECH-AUDITS.md` for the REL-05 pre-1.0 policy statement).

> **Note on history:** this file was introduced 2026-07-05 with the
> `v0.13.1` release. Entries for `v0.2.0`–`v0.12.3` were backfilled on
> 2026-07-16 from `git log`, dated by tag date — best-effort summaries of
> each release's main changes, not exhaustive commit lists (see
> `git log <prev>..<tag>` for those). Every release from `v0.13.1` forward
> gets a dated entry as part of the release PR.

## [Unreleased]

### Added

- A settled read with no data is now a decision the repo has written down, not
  one re-derived per bug. [ADR 0010](docs/adr/0010-settled-read-states.md)
  states the rule sixteen previous fixes (#319, #320, #326, #327, #328, #338,
  #339, #341, #347, #348) were each arriving at separately: a query is in
  flight, settled with data, or settled with none, and the third state must be
  rendered as itself rather than as a `0`, an empty list, or an absent card.
- `npm run reads:check` (`frontend/scripts/check-settled-read-states.mjs`),
  wired into `npm run verify` and CI's required `Lint` job. It is a
  two-directional ratchet over `settled-read-states-baseline.json`: a new
  occurrence of the shape fails, and a baseline entry that no longer matches
  anything also fails, so a fix cannot leave its own permission behind. Four
  occurrences are accepted, each with the reason its absence asserts nothing a
  reader would act on. The gate detects one shape and the ADR says plainly
  which shapes it does not.

### Fixed

- The dashboard climate card no longer renders a failed read as a calm night
  (#351). `if (!data) return null` put a failed climate read in the same
  silence as "no household active" and "no location saved with the integration
  off", so a household that would have seen the freeze warning — "Low of X°C
  tonight. Bring tender plants indoors.", the only place the product carries
  it — saw nothing at all, and nothing is what a night with no warning looks
  like. A settled read with no data now says the local climate could not be
  read and that tonight's frost, heat, and rain warnings are unchecked rather
  than clear. Still-in-flight stays silent, and the genuine "no location"
  states are unchanged.
- Pet toxicity no longer rides on the care-guide fetch (#350). `CareGuideCard`
  was the only surface on the plant detail page carrying pet toxicity — the one
  fact its own docstring called "actively dangerous to miss" — and its
  `if (isLoading || !data) return null` discarded a failed or slow
  `/species/:id/guide` read in a way indistinguishable from "this species has
  no guide". Toxicity moved to `PetToxicityNote`, which the plant page now
  mounts on its own read, and which already distinguishes "couldn't check" from
  "unknown" from "toxic" so none of them can resemble confirmed-safe. The note
  takes a `context` so a plant already in the household is not told it can
  still be added. `CareGuideCard` keeps only the long-form guide, and now
  separates a failed read (says so) from a provider `null` (renders nothing,
  because that is a real answer).
- A failed API-key read no longer renders as "Active keys (0)" / "No keys yet."
  (#349). Only `isLoading` was ever checked, so an admin hitting a transient
  read failure saw the zero-state while keys issued earlier still granted
  programmatic read/write access to household data, with no error shown and no
  Revoke control to reach them. The list now says the read failed and that any
  key issued earlier is still active until revoked; the count is published only
  when it was actually read. A genuine empty is unchanged.
- `docs/testing.md`'s test-case snapshot was five cases stale for the frontend
  unit layer (the file-count gate does not check cases). Re-measured and
  re-dated.

## [0.23.2] - 2026-08-18

### Changed

- The model card stops publishing its two eval figures as though they were
  measurements. `recall@3 = 1.0` and `own-chunk-top-1 = 1.0` are 1.0 by
  construction: the eval uses each corpus chunk's own precomputed embedding as
  the query vector, and cosine(x, x) = 1 is the maximum possible score, so the
  target cannot rank anywhere but first. That caveat existed only in
  `evals/eval-baseline.json`'s `method` field and never reached the card. The
  `model-index` front matter now carries self-describing metric ids and the
  caveat inline, and the narrative explains what the numbers are a floor on.
- The model card's benchmark size is corrected from "22-question" to the real
  134 items, of which 102 corpus-class items are scored and 32 adversarial
  items are labelled but ungraded. The count went stale on 2026-07-17 and
  survived a month; the card's recheck cadence now includes any change to
  `evals/benchmark.jsonl` or `evals/eval-baseline.json`, and
  `backend/tests/eval/ragRetrieval.eval.test.ts` fails if the front matter
  disagrees with either file.
- `docs/roadmap.md`'s "Measured values" line carried the same two figures, the
  same "22-question", and a measurement date of 2026-07-05 — twelve days before
  the baseline it cites was generated. It now dates the baseline correctly,
  states the by-construction caveat, and splits the standard's target into the
  half that is met (question count) and the half that is not (live scoring).
- `evals/eval-baseline.json`'s `method` said `ownChunkTop1Rate` is ~1.0 by
  construction but did not say the same of `recallAt3`, which the same cosine
  identity forces. It now says both.
- The vendored portfolio standards in `docs/standards/` are refreshed to
  v2.0.0 (#310). Documentation only — no CI gate, workflow, or code changed as
  part of the refresh.

### Fixed

- The per-task streak chip on the plant detail page no longer states a capped
  count as a measured one. #328 fixed `CareReportCard` because
  `plant.recentCompletions` is capped at `RECENT_COMPLETIONS_LIMIT` rows across
  ALL of a plant's tasks; `PlantDetailPage`'s `TaskRow` consumes that same array
  through the same mechanism and was not touched, so it kept the same defect one
  component over. A plant watered forty consecutive times could render at most
  "10-cycle watering streak", and fewer than that in practice — those ten slots
  are shared with the plant's fertilize/prune/repot rows, so a multi-task plant's
  water streak is bounded by however many water rows survive the interleave.
  `computeStreak` now returns a `StreakReading` (`cycles` plus `truncated`)
  instead of a bare number: `truncated` is set when an unbroken run consumes
  every row this task has in a window that came back full, which is precisely
  the case where the window — not the household's care — is what ended the run.
  `streakLabel` renders that as "10+ cycle watering streak (within the last 10
  logged)" rather than "10-cycle watering streak", the same
  state-the-window treatment `CareReportCard`'s labels got. An exact reading is
  unchanged. Note the remaining gap, which this does not close: when a task's
  newest completion is crowded out of the shared window entirely, the chip still
  renders nothing — absence rather than a false claim, but not distinguishable
  from "no streak".
- `PageHeader`'s underline test no longer matches the SVG through a
  `svg[viewBox="…"]` CSS attribute selector. jsdom 30 stopped matching
  camelCase SVG attribute names in selectors — on 29.1.1 both the camelCase and
  lower-cased spellings match, on 30.0.1 neither does, while
  `getAttribute('viewBox')` still returns the value on both — so the assertion
  was engine-dependent, not a statement about the component. It now reads the
  attribute, the way the neighbouring assertion in the same file already did.
  This is what fails `Test Frontend` on the jsdom 30 bump (#312); with this on
  `main`, that bump goes green on a rebase.
- The RAG grounding guard no longer reports a pass for an answer it checked
  nothing in. It returns a three-state verdict (`verified` / `unverified` /
  `ungrounded`) instead of a boolean `grounded`, reports numeric content it
  could not resolve to a checkable claim shape, and logs each verdict under its
  own event name so `chat_grounding_checked` can no longer describe an answer
  with zero claims checked. Word-quantity dose instructions ("half strength",
  "double the dose", "twice the concentration") are now checked against the
  retrieved corpus like numeric doses — the corpus gives its dilution guidance
  in words, so a digit-only guard was still blind to it. Blocking behaviour is
  unchanged except that an unsupported word-quantity dose now blocks too. See
  [ADR 0009](docs/adr/0009-three-state-grounding-verdict.md).
- An unreadable plan-usage counter no longer satisfies the plan limit. The
  frontend's over-limit check was a boolean, so "under the cap" and "we could
  not read the count" were the same answer and the post-downgrade warning
  simply never appeared. `evaluatePlanLimits` replaces it with `within` /
  `over` / `unknown` per dimension, and billing settings now shows a third,
  distinct notice saying the check could not be made rather than staying
  silent. A genuine zero is still `within`.
- The dashboard status line no longer publishes a failed plants or tasks read
  as `0`. It keyed on the loading flag alone, so a fetch error rendered
  "Plants 0 / Due today 0 / Overdue 0" — indistinguishable from a genuinely
  empty household, and reassuring in exactly the wrong direction. Missing data
  now renders the same em dash the loading state uses.
- Activity rows for leaf-health checks recorded before the `demo` flag existed
  no longer claim a check ran. Those rows are indistinguishable from demo
  results — and a demo result means no image was analysed — so the feed now
  states the request and says the record does not show whether a real analysis
  or a demo result produced it, with a question-mark icon instead of the
  success tick. Rows that carry `demo: false` are unchanged.
- Climate tips no longer call OpenWeatherMap's outdoor reading "Indoor
  humidity". The reading is taken at the geocoded city centroid and there is no
  indoor sensor anywhere in the product, so the low-humidity tip now says
  "Outdoor humidity is around N%" and infers the indoor consequence in words
  instead of attaching the number to a room it never measured; the
  high-humidity tip is labelled the same way, and the dashboard climate card
  reads "N% outdoor humidity". A regression test asserts no tip puts a measured
  percentage next to the word "indoor". The `get_household_climate` chat tool
  describes its payload as outdoor for the same reason: the model was handed a
  bare `humidity` field and could phrase it as the user's room.
- The care report no longer presents a windowed count as a lifetime one.
  `GET /plants/{id}` returns at most ten completions across all of a plant's
  tasks, so "Total completions" and "Longest streak" were both capped at ten by
  construction for any well-used plant. Both are now labelled with the window
  they can actually see, the card says older care is not counted, and the
  window size is a named constant on both sides of the API instead of a bare
  `10`.
- `docs/observability.md` no longer tells the on-call to confirm `/health`
  "reports every component healthy". `/health` hardcodes `auth` and `mail` to
  `unknown` — deliberately, since neither is probed — so that step could never
  be satisfied, and a green `/health` is not evidence that Cognito or SES
  recovered.

### Security

- Bumped the `js-yaml` override from `^4.2.0` to `^4.3.1`, closing
  GHSA-5p4m-2wfm-xmqj (quadratic CPU consumption in `!!omap` resolution, high,
  affected `>= 4.0.0, < 4.3.1`). The old range resolved to 4.3.0. js-yaml
  reaches the graph transitively through `cosmiconfig` and `@lhci/utils`, so
  Dependabot cannot open this bump itself — the override is the only lever. The
  only package change in the lockfile is `js-yaml` 4.3.0 to 4.3.1. Scope is
  development, so `npm audit --omit=dev --audit-level=high` was already passing
  and is unaffected.
- The production deploy workflow's advisory tag-signature check can now
  actually verify a release tag. `git verify-tag` ran with no SSH
  allowed-signers mapping configured, so every tag — signed or not — took the
  warning path. The maintainer's SSH signing key (the key GitHub shows as
  verified, and the same entry `outcome-receipts` releases are authorized
  against) is now committed at `.github/allowed_signers`, and the check points
  `gpg.ssh.allowedSignersFile` at it before verifying. The step stays advisory
  (REL-08); it should flip to blocking once this release's signed tag verifies
  in CI.

## [0.23.1] - 2026-08-09

### Changed

- RAG grounding now recognizes care quantities that carry volume, mass,
  dilution, repetition, and fertilizer-ratio units, verifies unit-aware dose
  evidence (including `per` and `/` denominators), and records content-free pass
  telemetry with checked-claim and source counts. Zero-claim passes are now
  observable instead of looking identical to a substantive verification.
- Frontend coverage floors ratcheted from lines 65 / statements 64 / branches
  59 / functions 57 to lines 76 / statements 75 / branches 65 / functions 66
  (`frontend/vitest.config.ts`), backed by new unit coverage for the chat SSE
  stream parser, the browser telemetry vitals and error rail (including the CLS
  session-window rule and the per-session error cap), client-side image
  downscaling, the browser-notification wrapper, locale formatting, the
  UI-preferences store and its v0→v1 migration, and the previously untested
  task, household, space, species, climate, sitter, and photo-upload service
  paths. No production code changed.
- `npm run verify` (and so `make verify` and the pre-push hook) now runs
  `test:coverage` rather than plain `test`, so both workspaces' coverage floors
  fail locally at the same point CI's `Test Frontend` / `Test Backend` jobs
  would fail them.
- Backend coverage floors ratcheted from lines 80 / statements 80 / branches
  71 / functions 80 to lines 82 / statements 81 / branches 74 / functions 82
  (`backend/vitest.config.ts`), reflecting coverage that feature/fix PRs
  already added since the last rung (2026-07-05) rather than a dedicated
  coverage push. No production or test code changed.

### Fixed

- Household activity now gives every emitted event type a descriptive row,
  includes imports in the Plants filter, and labels demo leaf-health results
  as canned rather than durable real assessments. The event renderer and
  filter exhaustively cover the frontend's declared event union while retaining
  a safe fallback for older clients that receive a newer event type.
- Billing usage counters now preserve genuine zeroes while reporting missing
  or unreadable household counters as unavailable through the additive
  `usageDetail` response. The legacy `usage` object remains numeric-only and is
  omitted when incomplete, keeping cached clients safe; current plan meters no
  longer show unknown usage as `0`, and a known over-limit count still surfaces
  the post-downgrade warning when the other count is unavailable.
- README's Code Quality conformance row claimed the backend "clears 80% on
  all four coverage metrics" — untrue for branches, which measured 73.77% at
  the 2026-07-05 rung this claim was written against and 76.01% today. The
  row now states backend branches and all four frontend metrics remain below
  the 80% target, matching the honest-not-aspirational standard the same
  section commits to.
- The plant-name nursery's unit spec pinned its random draw. Previously it used
  the real `Math.random`, so whether the "reroll until the name differs" retry
  ran — and therefore the repo's measured frontend coverage — changed between
  otherwise identical runs.
- Removed superseded repository-visibility language from the CI workflow; its
  comments now describe the active public CodeQL path directly.

## [0.23.0] - 2026-07-25

### Added

- Red-team injection corpus for the chat tool layer
  (`evals/redteam/injection-corpus.json`, 9 payloads mapped to OWASP LLM01/02/06)
  and a CI-gated test asserting prompt-injection strings stored in
  user-controlled fields cannot widen a tool's household scope, leak PII to the
  model, or coerce a write past the confirm-card validation. Dated report in
  `docs/audits/red-team-2026-07-17.md`. This is the offline/data-layer slice of
  the AI-eval standard's §2 red-team requirement; live-model refusal scoring,
  Promptfoo, and Garak remain waived and not built.
- AI-eval benchmark expanded from 22 to 134 items across four labeled
  behavior classes (102 corpus-anchored real-user questions at 8–10 per
  article, 12 should-refuse, 10 out-of-corpus/abstain, 10
  household-data/tool-use), with new CI gates: schema validation,
  per-article and per-class count floors, and `expectedTools` checked
  against the live tool registry. Retrieval metrics still use the anchor-
  chunk-embedding proxy; the adversarial labels are data for the future
  generation-layer eval and are not yet scored against live model output.
- Production-bundle browser coverage for notification permissions, service
  worker activation, foreground reminder timing, photo upload recovery,
  account deletion, cutting grafts, sitter care, and public integration
  boundaries across Chromium, Firefox, WebKit, Mobile Chrome, and Mobile
  Safari.
- Version-aware production smoke cleanup that removes the exact disposable
  test object, every historical S3 version, and every delete marker even when
  application-level account cleanup fails.

### Changed

- Notification delivery now records channel-scoped outcomes and leases so a
  transient email, SMS, or push failure retries only that channel without
  duplicating successful sibling deliveries.
- Integration availability is reported conservatively: disabled or
  unconfigured weather, identification, pet-safety, telemetry, chat, and
  notification providers expose an actionable degraded state instead of
  claiming success or inventing data.
- Browser notification permission and foreground reminder state now
  resynchronize on focus, visibility changes, and page restoration.

### Fixed

- Account deletion now removes the Cognito user, every household/global
  DynamoDB record, memberships, assignments, history references, photo
  objects, historical object versions, and delete markers.
- The generated production service worker imports the background push handler,
  ships both files with no-cache headers, cleans stale subscriptions, validates
  push endpoints, and routes reminder deep links to the due queue.
- Plant photo creation recovers from a failed upload without creating a
  duplicate plant, then performs a real retry PUT, confirmation, byte fetch,
  and decoded-image render.
- Chat turns are idempotent under retries, stream configuration is deployed
  consistently, external-provider budgets are atomic, and local HTTP behavior
  matches the production route surface.
- Quiet hours, per-channel delivery, welcome-email deduplication, reminder
  aggregation, household switching, public invite/share/sitter boundaries,
  keyboard focus, 320px reflow, reduced motion, and modal accessibility now
  behave consistently across supported browser engines.

### Security

- Push endpoints are restricted to approved HTTPS provider origins with
  request caps, timeouts, and stale-subscription cleanup.
- Plant-identification uploads stay privacy-bounded, external API budgets fail
  closed under concurrency, and deployment IAM now grants only the additional
  Cognito/S3 version operations required for complete erasure.

## [0.22.0] - 2026-07-19

### Added

- Free Seedling account registration is open again for households with up to
  10 plants and 6 members; paid plans and every payment path remain disabled.

### Changed

- Bitter Variable replaces Gloock across the site and generated brand assets.
- The landing page no longer uses its greenhouse-grid background, animated
  hero sprigs, or decorative section-divider artwork.

### Fixed

- SMS reminder bodies are now trimmed to the promised 140-byte budget by
  UTF-8 bytes rather than UTF-16 code units, so accented Spanish text or the
  streak emoji can no longer blow past the byte budget or split an emoji
  surrogate pair mid-code-point.

## [0.21.0] - 2026-07-16

### Added

- First-party, privacy-bounded browser RUM now captures sanitized errors and
  LCP/CLS/INP with normalized route and release correlation; authenticated,
  typed product events now reach CloudWatch even without PostHog credentials.
- A machine-checked 28-day SLO contract, health-excluded application RED
  metrics, per-route dashboard panels, fast/slow availability burn alerts,
  frontend error alerts, and DynamoDB write-throttle coverage.

### Fixed

- CloudWatch HTTP API panels and alarms now use the real API ID and the `4xx` /
  `5xx` metric names instead of querying nonexistent REST API series.
- Notification settings now expose actual SMS capability and hide the phone
  verification flow while production delivery is disabled, preventing the
  user-facing 503 loop.
- Dashboard, plant, task, and notification queries wait for a valid household
  context before issuing authenticated requests.

## [0.20.0] - 2026-07-16

### Added

- The dashboard now shows a bilingual Shared-care pulse until the household
  has a plant, an active care task, a second member, and a recent task
  completion by someone else. The ordered care-vine links directly to the
  next missing step and can be hidden on the current device for 30 days.
- Shared-care pulse actions emit a privacy-preserving, household-grouped
  analytics event so the collaboration activation hypothesis can be measured
  without sending plant, household, or member names.

## [0.19.0] - 2026-07-16

### Added

- The active Spaces view is now an operational care route, ordered inside to
  outside to unplaced, with each stop showing plant count, overdue or due-today
  work, next care, recorded conditions, usual caregiver, and current seasonal
  move suggestions.
- Every space card links to a URL-addressable scoped care round that preserves
  the existing task filters, claiming, vacation coverage, climate advice, and
  completion controls.
- Focused browser coverage now verifies the complete space-to-task flow across
  the CI browser matrix and includes a WCAG 2.2 AA scan of the populated view.

### Changed

- Operational space summaries are composed from existing household-scoped
  projections only when the active Spaces view is open, adding no migration,
  summary row, background job, or backend authorization surface.

### Security

- Public repository visibility is restored after a clean full-history Gitleaks
  scan and separate inspection of archived Lambda bundles. GitHub secret
  scanning, push protection, and private vulnerability reporting are active
  with no open secret alerts.
- CodeQL and zizmor again publish findings to the public repository's code
  scanning view, and OpenSSF Scorecard public publishing resumes. The
  commercial hold and every runtime signup/payment control remain unchanged.

## [0.18.0] - 2026-07-16

### Added

- Spaces can record whether outdoor plants are exposed to rain, so weather
  guidance targets only plants whose current placement is actually affected.
- Plants can remember preferred summer and winter spaces and receive an
  explicit, latitude-aware move suggestion when the active season changes.
- Placement-fit guidance can flag conservative light-level mismatches and
  known pet-toxicity concerns using optional space conditions.
- Active sitter links now show each due plant's current space and short
  placement note without exposing household climate data, private notes, or
  member identity details.
- Spaces can name a usual caregiver. New tasks for plants in that space inherit
  the caregiver while explicit assignments continue to win and existing tasks
  remain unchanged.

### Changed

- Legacy spaces hydrate safe rain, light, pet-access, and caregiver defaults,
  so the new placement features require no data migration or backfill.

## [0.17.0] - 2026-07-15

### Added

- Households can define named indoor and outdoor spaces, browse plants by
  placement, and see unplaced plants without relying on free-form tags.
- Care Rounds group due work by space so a caregiver can finish one physical
  area at a time and track progress through the round.
- Task rows now show each plant's current space and indoor/outdoor context.
- Quick-move and bulk-move workflows let caregivers relocate plants between
  spaces while recording the placement change consistently.

### Changed

- The new move workflow remains a lazy-loaded chunk; the aggregate bundle
  budget is recalibrated with tight headroom while initial JS, vendor, and CSS
  budgets remain unchanged.

### Fixed

- CodeQL and zizmor now retain SARIF artifacts on private repositories without
  requiring the unavailable GitHub Advanced Security upload endpoint.
- Production UI browser assertions now match the commercial-hold pricing and
  billing headings.

## [0.16.3] - 2026-07-14

### Security

- A repository-wide commercial hold now fails closed across public plan
  surfaces and both Stripe session-creation paths. Public UI and API responses
  expose no prices, billing intervals, purchase, upgrade, or paid-plan
  registration controls; production price IDs remain blank; and tests pin the
  shared status, exact runtime gate, and Terraform invariants. The commercial
  hold does not gate Stripe webhook code used for cancellation and other
  already-originated event processing.
- The same hold now closes new-account acquisition end to end: public surfaces
  and social artwork contain no registration CTA or free/no-card offer, the
  stable registration route has no form, public signup returns `503` without a
  Cognito call or local mutation, and Cognito independently requires
  administrator-created users. Existing login, recovery, and already-pending
  confirmation/resend flows remain available.

### Changed

- Dependency maintenance now advances every compatible in-range package,
  migrates both workspaces to Zod 4, aligns Commitlint and CodeQL action
  versions, removes the obsolete external UUID declarations, and records a
  complete disposition for all 84 historical Dependabot PRs. Tailwind 4 and
  TypeScript 7 remain explicit major-version holds, not silently skipped bot
  work.
- Dependabot's GitHub Actions cadence returns to weekly now that every required
  Node 24-compatible action major has landed; the configured dependency labels
  now exist in the repository.
- The legal pages now state the minimum account age and describe temporary
  sitter-link access in plain language; the DPIA and profile documentation now
  match the implemented deletion-time anonymization behavior.
- Current conformance and accessibility documentation now replaces stale
  pre-remediation claims, and `make verify` provides the documented local CI
  parity entry point.
- Chat now has a Terraform-controlled incident kill switch that stops new sync
  and streaming model turns before any spend or persistence while leaving
  history/reporting available.
- Architecture and quality records now recognize the shipped schedules,
  Perenual integration, and successful PITR drill instead of carrying them as
  unfinished work.

### Fixed

- RAG answers now block unsupported quantitative care claims before they are
  persisted or delivered; streamed RAG text waits for the same grounding check.
  A later authoritative plant/task/climate result now joins historical RAG
  evidence through explicit numeric facts and collection counts, so its real
  numbers pass without letting incidental digits in IDs/dates—or a fabricated
  count—disable blocking.
  Tool outputs and history replay cross a recursive PII-field sanitizer, raw
  tool exception messages no longer enter prompts/logs, and repeated identical
  tool calls reuse the validated result instead of duplicating work/cards.
- The responsible-tech, model-card, and EU-transparency records now reflect the
  disclosure footer and authenticated Playwright assertion that were already
  present, rather than carrying a stale open-gap claim.
- Long chat conversations follow DynamoDB cursors newest-first and restore the
  bounded window to chronological order, so a page boundary—or the defensive
  ten-page cap—cannot hide the actual tail of a thread.
- Session restore now uses the still-valid refresh token before logging a user
  out when the short-lived ID token has expired, and rejects syntactically valid
  `/auth/me` payloads that do not match the complete user shape.
- Lifetime checkout metadata names the exact recurring subscription it
  replaces. The webhook first wins the out-of-order DDB condition and stages a
  private retry marker, then cancels that exact subscription; a stale lifetime
  event cannot cancel a newer subscription, a Stripe failure remains safely
  retryable after the public subscription ID is cleared, and a fully recorded
  redelivery cannot cancel the same subscription twice. Concurrent duplicate
  deliveries now elect one cancellation worker through an expiring atomic
  claim, backed by an event-stable Stripe idempotency key.
- A crashed seasonal pest evaluation removes its daily claim marker so a later
  invocation can retry instead of silently suppressing that day's alerts.
- The checked-in inbound-mail Lambda archive now matches its byte-safe,
  scan-verdict-enforcing source instead of deploying the older UTF-8-reencoding
  forwarder.
- The landing-page visual regression gate now pins its A/B experiment bucket,
  removing random control-versus-treatment screenshot failures.

## [0.16.2] - 2026-07-12

### Added

- Store-ready iPhone, iPad, and Android screenshots, app icons, Play feature artwork, localized
  listing metadata, and deterministic validation/generation scripts for repeatable releases.
- Public support and account-deletion pages, in-app AI response reporting, native privacy
  disclosures, and complete account-cleanup coverage for store policy compliance.

### Changed

- Native networking now uses the platform HTTP stacks, mobile billing surfaces are purchase-free,
  and release builds strip source maps before syncing into the iOS and Android shells.
- iOS and Android release versions advance to `0.16.2` (build/version code `1602`).

### Fixed

- Store screenshot generation is isolated from the default Playwright suite so release-only
  projects cannot be discovered by general CI browser profiles.

## [0.16.1] - 2026-07-12

### Fixed

- Production deployment no longer passes the iOS `capacitor://` WebView origin to AWS-managed
  CORS APIs, which reject custom URL schemes; AWS retains the valid web and Android origins while
  the backend prepares exact-origin preflight handling for the complete native allowlist.
- CORS preflight metadata now includes the implemented `PATCH` method and all four supported
  request headers, with exact-origin tests for web, iOS, Android, and rejected callers.
- Streaming chat now advertises only its `POST` contract, rejects other non-preflight methods,
  and refuses wildcard CORS configuration so origin-policy drift fails closed.

## [0.16.0] - 2026-07-12

### Added

- Native iOS and Android app shells (Capacitor) wrap the existing web app so it can ship to the
  App Store and Play Store; build flow and store-submission checklist live in `docs/mobile.md`.
- Inside the mobile apps, the notification settings device toggle registers a native push device
  token with the backend (capture-only groundwork — reminder delivery to native devices ships
  with the APNs/FCM sender).
- Feature-flagged, server-to-server Sprout integration for corpus-grounded plant-care answers,
  with HMAC authentication, minimized household context, nickname/contact redaction, citation
  persistence, and a temporary fallback to the existing assistant.
- Independent application-domain and Route 53 hosted-zone configuration, allowing an app
  subdomain without treating it as its own hosted zone or automatically creating a `www` alias.
- A deterministic vector-first brand pipeline that regenerates and verifies every web, PWA,
  social, iOS, and Android image derivative, including Android 13 monochrome launcher support.

### Changed

- Billing inside the mobile apps is read-only for store payment compliance: plan checkout and
  subscription-management actions stay web-only, with a neutral notice shown in the apps.
- The API's CORS allowlist now also accepts the mobile shells' origins, and the layout respects
  device safe areas (notch, status bar, home indicator) on edge-to-edge screens.
- The interface now uses one greenhouse identity across navigation, plant placeholders, empty
  states, launch screens, app icons, social previews, and native shells, replacing the remaining
  Capacitor template artwork and inconsistent legacy marks.
- Public, authentication, onboarding, dashboard, and plant surfaces now share a brighter
  greenhouse-glass visual system with stronger mobile navigation, contrast, typography, and
  accessible decorative semantics.
- The public OpenAPI contract now documents the implemented, opt-in `write:tasks` complete and
  snooze endpoints instead of incorrectly describing v1 as read-only.

### Fixed

- Notification artwork now resolves from the shipped brand path, and the stacked BrandMark
  variant no longer points to a missing file.

## [0.15.4] - 2026-07-11

### Fixed

- The edit-plant species test now waits for observable remote lookup results instead of racing a fixed delay during release builds.

## [0.15.3] - 2026-07-11

### Added

- Plants can be archived without losing tasks, photos, care history, or propagation lineage, then restored through the cap-safe lifecycle flow.
- Archive and restore transitions now appear in the household activity story and emit a lifecycle analytics event.

### Changed

- Plant removal now leads with the reversible archive action, past-plant cards show their lifecycle state, and inactive care schedules render as paused and read-only.

## [0.15.2] - 2026-07-11

### Added

- Plant name suggestions now recognize 14 plant families from common and botanical species names, tailor every personality style to the match, and show localized species context in the name nursery.

## [0.15.1] - 2026-07-11

### Added

- Public pages now publish route-specific Open Graph, Twitter, canonical, robots, breadcrumb, and structured application metadata for stronger search and link previews.
- Stripe Tax can be enabled explicitly after registrations and product tax codes are configured, with deployment wiring and operator documentation included.

### Fixed

- Checkout attempts now carry household-scoped idempotency keys, preventing duplicate Stripe sessions during transport retries.
- Delayed lifetime payments grant access only after Stripe confirms payment, and replacing an existing subscription retries safely if cancellation is temporarily unavailable instead of risking continued billing.

## [0.15.0] - 2026-07-11

### Fixed

- The pricing billing-interval toggle overflowed a 320px viewport on the landing page (WCAG 1.4.10), surfaced by the new reflow spec. (The page-header action-row reflow fix originally on this branch was superseded by the broader mobile-first rework in 0.14.1.)

### Added

- A playful “Name Nursery” when adding plants, with punny, distinguished, chaotic, sweet, and species-aware suggestions; preview-and-reroll controls; and localized English and Spanish interface copy.
- Playwright a11y specs closing the A11Y-07/08/09 audit gaps: keyboard-only path (login → skip link → complete a due task, with a visible-focus-ring assertion), `prefers-reduced-motion` behavior (both the `motion-safe:` variant and the global freeze rule), and 320×256 reflow across public + authenticated routes.
- Backend tests pinning the structured-logging contract (OBS-09/10/12): every pino record is one `jq`-parseable NDJSON line with `service`/`env`/label-`level`/`msg`, `withRequest` binds `requestId`/`userId`/`householdId`/`traceId` onto child records, and `loggingMiddleware` correlates the parsed X-Ray root id from `_X_AMZN_TRACE_ID` into request-scoped logs. `createLogger()` factory extracted so tests exercise the real serialization path.
- `.github/workflows/e2e-crossbrowser.yml` — weekly (plus on-demand `workflow_dispatch`) run of the full Playwright e2e + a11y suite on firefox and webkit, closing the QM-03 compatibility gap (the per-PR gate stays chromium-only).

## [0.14.2] - 2026-07-10

### Fixed

- SMS verification now returns a clear service-unavailable response when delivery is disabled or rejected instead of falsely reporting that a code was sent.
- Failed verification deliveries remove their unusable pending code, and SMS dry-run logs no longer expose phone numbers or one-time codes.
- Wired the root Terraform SMS gate through to the API module so production configuration can enable delivery after AWS approves SMS production access and origination registration.

## [0.14.1] - 2026-07-10

### Fixed

- Completed tasks now remain visibly completed while server state converges, with the action protected against duplicate submissions.
- Settings deep links now open the requested section, including `/settings/billing`, and tab navigation works with arrow, Home, and End keys.
- Failed plant-photo uploads can retry the same file, and clipboard actions now report failures instead of silently claiming success.
- Removed mobile overflow and cramped controls across task, plant, household, settings, chat, dialog, and toast interfaces, including the 320 px viewport.

### Changed

- Reworked frontend layouts mobile-first with consistent full-width actions, safe-area handling, minimum touch targets, responsive dialogs, and accessible status and error announcements.
- Expanded browser coverage across Chromium, Firefox, and WebKit, responsive viewport states, authenticated routes, dialogs, keyboard interactions, and WCAG scans.

## [0.14.0] - 2026-07-10

### Fixed

- Completing a task now updates the UI immediately and can no longer be visually undone by an eventually consistent list refresh.
- Downscale photos client-side before the "Identify from photo" upload, closing the iPhone leaf-health upload size-mismatch class of bugs.

### Added

- New plants can automatically receive a visible, editable care-task bundle based on their species, with an opt-out before saving.
- README `## Standards conformance` table declaring applicability/state for all 11 vendored standards (DOC-11/12/13).
- `docs/RESPONSIBLE-TECH-AUDITS.md`: ASVS level, RTF §A–F applicability, SEC-40 §F declarations, and the dated AI-EVALUATION-STANDARD waiver (AIEV-01).
- `evals/` — starter AI-evaluation harness for the Bedrock plant-care chat: a corpus-grounded benchmark set, a citation/grounding guard with unit tests, and a committed `eval-baseline.json` wired into a new CI job (AIEV-02, AIEV-12, AIEV-26).
- `model-card.md`, `docs/audits/ai-risk-register.md`, `docs/audits/eu-ai-act-classification.md` (RTF-05/09/12, AIEV-22).
- `.github/CODEOWNERS`, `.nvmrc`, ADR-0005 (npm-workspaces monorepo), ADR-0006 (standards applicability declarations).
- `npm run verify` — chains format:check → lint → typecheck → test → audit gate → bare-marker grep, mirroring CI stages 1–5 (CICD-27).

### Changed

- CI: Node 20 → 22 (LTS) across all three workflows + `.nvmrc` + `engines.node`.
- CI: `gitleaks` pinned version 8.21.2 → 8.30.1.
- CI: Lighthouse gate no longer skippable via a human-applied `skip-lighthouse` PR label — it now runs automatically based on whether the diff touches `frontend/**`, closing the OBS-23/24/25 + A11Y-02 bypass.
- `cd-staging.yml`: removed `continue-on-error: true` from the staging E2E step so a real failure is no longer silenced.
- All three `package.json` versions bumped from the stale `0.1.0` to the actual shipped version, `0.13.1`, matching the `v0.13.1` git tag (REL-02/REL-03).
- `docs/security.md` A06 and `docs/accessibility.md` corrected to stop overstating current enforcement (Renovate/Dependabot are configured, not "recommended next step"; the axe e2e gate enforces WCAG AA, not an AAA slice).

### Security

- Added a `gitleaks protect --staged` pre-commit hook (Gate 1) alongside the existing CI gitleaks run (Gate 2).
- Public-API keys are now hashed with scrypt (memory-hard) instead of unsalted SHA-256 for the `GSI3` lookup index. The hash stays deterministic (a fixed application salt) so lookup remains a single point read; a per-hash random salt was ruled out because it would break lookup-by-key. Closes CodeQL `js/insufficient-password-hash`. **Breaking for the public API:** any API key issued before this change no longer resolves and must be re-created under Settings → API keys (pre-launch; no plaintext is stored, so old hashes cannot be migrated).
- The post-deploy smoke test now derives its throwaway account email from `crypto.randomUUID()` rather than `Math.random()`, so a mid-run account name is no longer predictable/squattable. Closes CodeQL `js/insecure-randomness`.

## [0.13.1] - 2026-07-05

### Fixed

- Photo-upload size mismatch affecting iPhone leaf-health uploads, plus five other deferred bugs found in the same sweep (#174).

## [0.13.0] - 2026-07-05

Tag cut prior to this changelog's introduction — see `git log v0.12.3..v0.13.0` for the full commit list.

## [0.12.3] - 2026-07-05

### Fixed

- Geocode space-separated "city country/state" climate queries (#172).

## [0.12.2] - 2026-07-04

### Fixed

- Swept the Perenual integration for the remaining missing-data-reported-as-a-false-answer bugs (#171).

## [0.12.1] - 2026-07-04

### Fixed

- Stop claiming "no watering needed" when Perenual species data is simply missing (#170).

## [0.12.0] - 2026-07-04

### Added

- Unified the whole app on the garden-journal design system (#168).

### Fixed

- Removed members are locked out only on member-scoped routes, plant reactivation is cap-checked with stale seedling member counts corrected, and "asparagus fern" no longer gets a false non-toxic verdict (#163, #164, #165).

### Changed

- Landed 8 verified major dependency upgrades (Vite 8 among them); the Tailwind 4 and Express 5 bumps were held and reverted to keep `npm ci` green on main (#167, #169).
- Lambdas moved to arm64 and a bare-marker CI gate was added (#166).

## [0.11.1] - 2026-06-21

### Added

- Vendored the portfolio standards into `docs/standards/` and hardened the CI workflows (#137).

### Fixed

- Dead-domain canonicals/sitemap corrected and repo findability metadata enriched (#138).

## [0.11.0] - 2026-06-21

### Added

- Chat turn idempotency and atomic budget reservation (#136).

## [0.10.0] - 2026-06-21

### Fixed

- Chat billing records partial usage on failure, persists tool pairs atomically, and aborts abandoned streams (#135).
- The last-admin guard is atomic against concurrent demote/remove, and admin UI is gated on the active household's role rather than the claim default (#130, #131).
- Confirm-email routes to sign-in and preserves the invite redirect (#134).
- The weekly digest claims its send slot only after a real send (#132).

## [0.9.0] - 2026-06-21

### Fixed

- A reminder is counted delivered only on a real send (#124).
- Tokens refresh after joining a household so the new household claim applies (#129).
- Chat messages are ordered by an atomic per-conversation sequence (#128).
- Billing resolves the plan from the live price and gates conversion on dedup (#125).

## [0.8.0] - 2026-06-21

### Added

- Annual plans (Garden $39.99/yr, Greenhouse $79.99/yr) and a one-time lifetime Garden plan, with server-confirmed `subscription_activated` analytics carrying a household group key (#109, #112, #113, #116).
- An honest notice when a species has no care data (#110).

### Security

- Hardened the mail forwarder, rate-limited the chat stream, tightened IAM/PITR/MFA, and patched the js-yaml DoS advisory via an npm override (#108, #118).

## [0.7.0] - 2026-06-17

### Added

- No-account, time-boxed sitter links so a plant sitter can check off tasks (#100).
- A free pet-safe plant checker page, a shareable cutting card, and six new care guides plus two blog posts (#96, #99, #101).
- Welcome email and first-plant activation polish (#102).

### Fixed

- Per-function, DynamoDB, and api-5xx alarms treat missing data as not-breaching (#94).

## [0.6.0] - 2026-06-16

### Added

- The free plan now covers the whole household, up to 6 members (#93).
- A heads-up when adding a plant that's toxic to pets (#91).
- Warmer reminder copy and a welcome for solo plant-keepers (#92).

## [0.5.0] - 2026-06-16

### Fixed

- Code-review remediations across backend, frontend, and infrastructure: DND reminders, activity pagination, assignee validation, overdue scoping, gated prod apply, deploy-role deny, and more (#87, #88, #90).

### Changed

- React 18 → 19 (#86).

## [0.4.0] - 2026-06-16

### Added

- The landing page now sells the full range of personas and capabilities (#82).

### Fixed

- The differentiators band uses a real list, not a definition list (#85).

### Changed

- Repo prepped for public release; Dependabot alerts cleared for vitest, vite, esbuild, and uuid (#83).

## [0.3.0] - 2026-06-12

### Added

- Frontend design overhaul: asymmetric hero, botanical icons, humanized copy, responsive fixes, de-genericized UI (#63, #65).

### Fixed

- CD captures the published Lambda versions for rollback instead of the `latest` alias (#60).

## [0.2.0] - 2026-06-11

First tagged release: the initial React + Lambda/DynamoDB/Cognito app plus the hardening sweep that made it deployable — CI/CD OIDC deploys with archived-zip rollback, blocking gitleaks + Semgrep + Dependabot, DLQs and audit alarms, incident/runbook/compliance docs, plant lifecycle states, and ELv2 licensing with inbound mail forwarding (see `git log v0.2.0` for the full list).
