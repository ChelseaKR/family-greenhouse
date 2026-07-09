# Documentation Audit

Last reviewed: 2026-07-08. Base branch: `main`.

This audit records the documentation sweep and remediation loop for this repository. It checks the docs as a system: entry points, root-level process and legal files, project scope, setup and validation notes, safety and privacy posture, architecture and planning docs, local links, and the places where code, tests, workflows, and docs meet.

## Audit Results

| Area                       | Result | Evidence                                                |
| -------------------------- | ------ | ------------------------------------------------------- |
| Entry docs                 | pass   | `README.md` present                                     |
| Security/process docs      | pass   | CONTRIBUTING.md, SECURITY.md, CHANGELOG.md              |
| Architecture/planning docs | pass   | 9 architecture/interface docs; 5 planning/research docs |
| Safety/privacy/audit docs  | pass   | 11 safety/privacy/accessibility/audit docs              |
| Validation surface         | pass   | 158 test files; 4 workflow files                        |
| Local doc links            | pass   | 272 authored-doc links checked; 0 unresolved            |

## Root-Level Documentation Audit

This section covers hand-authored documentation at the repository root and root-adjacent GitHub templates. It is separate from the `docs/` inventory so README, process, legal, release, and project-specific root files do not get hidden inside the larger docs tree.

| Surface                                | Result | Evidence                                                                                                                                      |
| -------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Root README                            | pass   | Present: `README.md`                                                                                                                          |
| Root process docs                      | pass   | Present: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`                                                                                     |
| Root legal, citation, and conduct docs | pass   | Present: `LICENSE`, `NOTICE`, `CITATION.cff`, `CODE_OF_CONDUCT.md`                                                                            |
| Other root project docs                | info   | `model-card.md`                                                                                                                               |
| Root-adjacent GitHub templates         | pass   | `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md` |
| Root/template doc links                | pass   | 45 root-level/template links checked; 0 unresolved                                                                                            |

Root-level files checked:

- `CHANGELOG.md`
- `CITATION.cff`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `model-card.md`
- `NOTICE`
- `README.md`
- `SECURITY.md`

Root-adjacent template files checked:

- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/CODEOWNERS`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`

## Remediation In This PR

- Added missing root-level remediation docs found by the audit loop, including legal, conduct, contribution, or security files where absent.
- Added `docs/PROJECT-SCOPE.md` as the plain-language project and boundary map.
- Added this audit record so future doc changes have a dated baseline.
- Added or refreshed the docs index so scope, audit, and primary docs are easy to find.
- Fixed or added root/doc remediation files: `NOTICE`, `docs/growth/prompts/README.md`, `docs/security-review-2026-05-31.md`, `docs/standards/README.md`.

## Repo Surfaces Checked

Package and workspace metadata:

- Node workspace `backend/package.json` named `backend` (scripts: build, dev, eval, lint, lint:fix, test, test:coverage, test:watch).
- Node workspace `frontend/package.json` named `frontend` (scripts: build, dev, lighthouse, lighthouse:desktop, lighthouse:mobile, lint, lint:fix, prebuild).
- Node workspace `package.json` named `family-greenhouse` (scripts: build, eval, format, format:check, lint, lint:fix, prepare, test).

Source and operations surfaces seen at the repo root:

- `backend/`
- `evals/`
- `frontend/`
- `infrastructure/`
- `package-lock.json`
- `package.json`
- `scripts/`

Workflow files checked:

- `.github/workflows/cd-production.yml`
- `.github/workflows/cd-staging.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/codeql.yml`

## Documentation Inventory

| Category                                   | Count | Representative files                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| architecture and interfaces                |     9 | `docs/adr/0001-record-architecture-decisions.md`, `docs/adr/0002-serverless-on-aws.md`, `docs/adr/0003-single-table-dynamodb.md`, `docs/adr/0004-no-waf-on-http-api.md`, `docs/adr/0005-npm-workspaces-monorepo.md`, `docs/adr/0006-standards-applicability-declarations.md`, `docs/adr/README.md`, `docs/architecture.md`, plus 1 more |
| entry points and repo process              |    12 | `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `CHANGELOG.md`, `CITATION.cff`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, plus 4 more                                                                                                     |
| operations and release                     |     4 | `docs/cicd-setup.md`, `docs/deployment.md`, `docs/incidents.md`, `docs/runbooks.md`                                                                                                                                                                                                                                                     |
| other docs                                 |    31 | `backend/tests/integration/README.md`, `docs/PROJECT-SCOPE.md`, `docs/README.md`, `docs/analytics.md`, `docs/b2b-greenhouse-mode.md`, `docs/billing.md`, `docs/brand-kit.md`, `docs/brand.md`, plus 23 more                                                                                                                             |
| planning and research                      |     5 | `docs/growth/prompts/04-research-synthesis.md`, `docs/marketing-plan.md`, `docs/roadmap.md`, `docs/strategy-review.md`, `docs/user-research.md`                                                                                                                                                                                         |
| safety, privacy, accessibility, and audits |    11 | `docs/DOCUMENTATION-AUDIT.md`, `docs/RESPONSIBLE-TECH-AUDITS.md`, `docs/accessibility.md`, `docs/audits/ai-risk-register.md`, `docs/audits/eu-ai-act-classification.md`, `docs/compliance.md`, `docs/quality-audit.md`, `docs/reviews/frontend-audit-2026-06-12.md`, plus 3 more                                                        |
| grouped generated/source content           |    11 | `backend/src/data/plant-care-corpus/` counted as a content group, not listed file by file                                                                                                                                                                                                                                               |
| grouped generated/source content           |    12 | `docs/standards/` counted as a content group, not listed file by file                                                                                                                                                                                                                                                                   |

Full hand-authored doc inventory checked by this pass:

- `.github/CODEOWNERS`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `CHANGELOG.md`
- `CITATION.cff`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `NOTICE`
- `README.md`
- `SECURITY.md`
- `backend/tests/integration/README.md`
- `docs/DOCUMENTATION-AUDIT.md`
- `docs/PROJECT-SCOPE.md`
- `docs/README.md`
- `docs/RESPONSIBLE-TECH-AUDITS.md`
- `docs/accessibility.md`
- `docs/adr/0001-record-architecture-decisions.md`
- `docs/adr/0002-serverless-on-aws.md`
- `docs/adr/0003-single-table-dynamodb.md`
- `docs/adr/0004-no-waf-on-http-api.md`
- `docs/adr/0005-npm-workspaces-monorepo.md`
- `docs/adr/0006-standards-applicability-declarations.md`
- `docs/adr/README.md`
- `docs/analytics.md`
- `docs/architecture.md`
- `docs/audits/ai-risk-register.md`
- `docs/audits/eu-ai-act-classification.md`
- `docs/b2b-greenhouse-mode.md`
- `docs/billing.md`
- `docs/brand-kit.md`
- `docs/brand.md`
- `docs/chat-rag-design.md`
- `docs/cicd-setup.md`
- `docs/climate.md`
- `docs/code-review-2026-06-01.md`
- `docs/compliance.md`
- `docs/deferred-resilience.md`
- `docs/deployment.md`
- `docs/development.md`
- `docs/external-services-setup.md`
- `docs/growth/prompts/01-editorial-pipeline.md`
- `docs/growth/prompts/02-species-care-page.md`
- `docs/growth/prompts/03-repurpose.md`
- `docs/growth/prompts/04-research-synthesis.md`
- `docs/growth/prompts/README.md`
- `docs/incidents.md`
- `docs/marketing-plan.md`
- `docs/multi-household.md`
- `docs/notifications.md`
- `docs/oauth-design.md`
- `docs/perenual.md`
- `docs/production-checklist.md`
- `docs/profile.md`
- `docs/public-api.md`
- `docs/quality-audit.md`
- `docs/reviews/2026-06-11-deep-review.md`
- `docs/reviews/2026-06-11-remediation-and-delivery.md`
- `docs/reviews/codebase-review-2026-06-17.md`
- `docs/reviews/frontend-audit-2026-06-12.md`
- `docs/roadmap.md`
- `docs/runbooks.md`
- `docs/security-review-2026-05-31.md`
- `docs/security.md`
- `docs/strategy-review.md`
- `docs/support.md`
- `docs/testing.md`
- `docs/user-research.md`
- `evals/README.md`
- `frontend/public/robots.txt`
- `model-card.md`

Grouped content counts:

- `backend/src/data/plant-care-corpus/`: 11 files
- `docs/standards/`: 12 files

## Link Check

- Checked 272 local links in authored Markdown and MDX docs.
- Unresolved authored-doc links after remediation: 0.
- Root-level/template unresolved links after remediation: 0.

Audit scope notes:

- Grouped content directories are counted as groups so they stay visible in the inventory without drowning it in per-file rows.
- Test-file counts by method: 158 files match `*.test.*`/`*.spec.*`; `docs/PROJECT-SCOPE.md`'s larger figure additionally counts fixtures, helpers, and READMEs under the test trees.

## Validation Notes

- The audit was generated from a clean worktree based on `origin/main` for this PR branch.
- Ran a local relative-link check over hand-authored Markdown and MDX docs.
- Ran an explicit root-level documentation presence and link check for README, process, legal, project, and template docs.
- Ran `git diff --check` across the PR worktrees after remediation.
- Product test suites remain the authority for runtime behavior; this PR changes documentation only.
