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
