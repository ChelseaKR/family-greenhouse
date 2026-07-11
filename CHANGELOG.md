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

### Added

- Backend tests pinning the structured-logging contract (OBS-09/10/12): every pino record is one `jq`-parseable NDJSON line with `service`/`env`/label-`level`/`msg`, `withRequest` binds `requestId`/`userId`/`householdId`/`traceId` onto child records, and `loggingMiddleware` correlates the parsed X-Ray root id from `_X_AMZN_TRACE_ID` into request-scoped logs. `createLogger()` factory extracted so tests exercise the real serialization path.

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
