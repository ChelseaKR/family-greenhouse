# Definition of Done — family-greenhouse

Instantiates `STANDARDS/QUALITY-AND-METRICS-STANDARD.md` ("Definition of Done").
Job names below are the **exact** check names as they appear on a PR; the
required set is enforced by the `protect-main` branch ruleset, committed at
`.github/rulesets/main.json`.

A change is **done** when every applicable gate below is green. "Applicable"
is decided by the gate's own trigger, not by judgment on the day.

## AUTO-GATE — CI on every PR

Required status checks (blocking via the `protect-main` ruleset):

| Check (exact name)                                 | Workflow                       | What it enforces                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lint`                                             | `.github/workflows/ci.yml`     | ESLint zero errors; Prettier `--check`; no bare TODO/FIXME/HACK markers; no silenced test/security/lint gates in workflows; API spec covers every handler route; commitlint |
| `Type Check`                                       | `ci.yml`                       | `tsc` frontend + backend, zero errors                                                                                                                                       |
| `Test Frontend`                                    | `ci.yml`                       | Vitest; coverage floors lines 65 / statements 64 / branches 59 / functions 57 (`frontend/vitest.config.ts`)                                                                 |
| `Test Backend`                                     | `ci.yml`                       | Vitest; coverage floors lines 80 / statements 80 / branches 71 / functions 80 (`backend/vitest.config.ts`)                                                                  |
| `Security Scan`                                    | `ci.yml`                       | `npm audit` on production deps (HIGH+CRITICAL block); Gitleaks (blocking, no `\|\| true`)                                                                                   |
| `SAST (Semgrep)`                                   | `ci.yml`                       | Semgrep scan, blocking                                                                                                                                                      |
| `Terraform Validate`                               | `ci.yml`                       | `terraform fmt` + `init` + `validate`                                                                                                                                       |
| `Build`                                            | `ci.yml`                       | frontend + backend build artifacts                                                                                                                                          |
| `E2E + accessibility (Playwright)`                 | `ci.yml`                       | e2e suite + axe accessibility checks                                                                                                                                        |
| `Lighthouse (mobile + desktop) (desktop)`          | `ci.yml`                       | Lighthouse budgets, desktop profile (runs when `frontend/**` changes)                                                                                                       |
| `Lighthouse (mobile + desktop) (mobile)`           | `ci.yml`                       | Lighthouse budgets, mobile profile                                                                                                                                          |
| `Bundle size`                                      | `ci.yml`                       | frontend bundle-size budget                                                                                                                                                 |
| `CodeQL analysis (javascript-typescript, actions)` | `.github/workflows/codeql.yml` | CodeQL for JS/TS **and** GitHub Actions workflows                                                                                                                           |

Auto-gates that run but are **not** in the ruleset's required list (honest note):

- `zizmor workflow audit` (`.github/workflows/zizmor.yml`) — path-filtered to
  PRs touching `.github/workflows/**` / `.github/actions/**`. It blocks those
  PRs when red, but cannot be a blanket required check without hanging PRs
  that don't trigger it.
- `Scorecard analysis` (`.github/workflows/scorecard.yml`, OpenSSF Scorecard) —
  runs on `main` push/schedule, not per-PR; posture monitoring, not a PR gate.

**Local parity:** `npm run verify` (repo root) = format:check + lint +
typecheck + test + `npm audit --omit=dev --audit-level=high` + the bare-marker
and silenced-gates guards — the local mirror of the CI gates that have no
browser/cloud dependency. Run it before pushing.

## REVIEW-GATE — human sign-off on the PR

- Acceptance criteria stated in the PR description (linked issue where one exists).
- Docs updated in the same PR: `docs/api-spec.yaml` for route changes (also
  auto-checked in `Lint`), runbooks/architecture docs for operational changes.
- New external attack surface (new public route, new processor, new bucket) →
  update `docs/security.md` threat notes and get an explicit security read of the diff.
- Data-inventory change (new stored field, new third-party egress, new
  notification channel) → update `docs/audits/dpia.md` in the same PR.
- New custom interactive component → keyboard + screen-reader pass; extend the
  Playwright a11y suite to cover it.
- Rollback plan stated for schema (DynamoDB shape) or Terraform changes.
- **Solo-maintainer caveat (honest):** the `protect-main` ruleset requires the
  13 status checks above but has **no** `pull_request` rule — GitHub cannot
  require self-approval for a single-maintainer repo. Review-gate items are
  discipline enforced through this document and the PR template, not by the
  platform. Revisit the ruleset if a second maintainer joins.

## RELEASE-GATE — before/at deploy

- Staging (`Deploy to Staging`, `.github/workflows/cd-staging.yml`): build →
  Terraform apply → deploy → post-deploy `E2E Tests` against staging must pass.
- Production (`Deploy to Production`, `.github/workflows/cd-production.yml`):
  versioned artifacts; every deploy job runs in the `production` GitHub
  Environment (its protection rules are the human sign-off).
- `docs/runbooks.md` updated if operational behavior changed; incident notes in
  `docs/incidents.md` if the release remediates one.

---

Last verified: 2026-07-10 (against `.github/workflows/` and ruleset id 18752847) ·
Recheck cadence: on any change to `.github/workflows/` or the branch ruleset —
re-verify job names match this file and the committed ruleset; quarterly otherwise.
