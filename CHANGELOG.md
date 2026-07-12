# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) once it
reaches 1.0.0 (pre-1.0: minor bumps may include breaking changes — see
`docs/RESPONSIBLE-TECH-AUDITS.md` for the REL-05 pre-1.0 policy statement).

> **Note on history:** this file starts 2026-07-05, backfilled for the
> current release (`v0.13.1`) only. Releases `v0.2.0`–`v0.13.0` predate this
> changelog; their content is reconstructable from `git log` / GitHub
> Releases if ever needed, but is not being retroactively reconstructed here
> (REL-10/REL-12 — fix forward from this point rather than spend a full pass
> reconstructing thirteen releases of history). Every release from here
> forward gets a dated entry as part of the release PR.

## [Unreleased]

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
