# Project Scope

Last reviewed: 2026-07-08. Base branch: `main`.

This file is a plain-language map of the project as it exists on `main`. It does not replace the README, roadmap, audit docs, or source comments. It points to them so a reviewer can see the whole shape without reading every file first.

## What This Project Is

Family Greenhouse is a household plant-care app. It tracks plants, care schedules, recurring tasks, reminders, subscriptions, and shared activity across a React frontend and AWS-backed TypeScript services.

Package metadata checked in this pass:

- Node workspace `package.json` named `family-greenhouse` (scripts: test, typecheck, lint, build, verify).
- Node workspace `frontend/package.json` named `frontend` (scripts: test, typecheck, lint, build, dev).
- Node workspace `backend/package.json` named `backend` (scripts: test, typecheck, lint, build, dev).

## Who It Serves

- Households sharing plant care across more than one person.
- Developers running the app locally without AWS credentials.
- Maintainers operating a PWA with real user data, billing, notifications, and photos.

## What It Covers

- A React/Vite frontend and local Express development server.
- Lambda-style backend handlers for plants, tasks, reminders, auth, billing, chat, households, notifications, and public API access.
- DynamoDB, Cognito, S3, API Gateway, CloudFront, Stripe, SES, SNS, and web-push integration docs.
- Runbooks, incidents, deployment notes, testing docs, and production checklists.
- Plant-care corpus content and Bedrock-backed chat paths.

## How It Is Put Together

- frontend/ holds the browser app.
- backend/ holds handlers, services, models, middleware, and the local server.
- infrastructure/ defines the AWS stack.
- docs/ contains operations, architecture, notification, billing, testing, and support material.
- Package workspaces coordinate the build and test commands.

Observed source and operations surfaces:

- `backend/`
- `evals/`
- `frontend/`
- `infrastructure/`
- `package.json`
- `scripts/`

GitHub workflow files checked:

- `.github/workflows/cd-production.yml`
- `.github/workflows/cd-staging.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/codeql.yml`

## Trust Boundaries

- This app handles PII, photos, household membership, billing, and notification channels.
- Local development falls back to structured logs when external credentials are absent.
- The standards table marks many items as gap tracked, which is useful because the live surface has real privacy and reliability stakes.

## Outside This Scope

- It is source-available under Elastic 2.0, not an unrestricted hosted-service clone license.
- Live email, SMS, push, Stripe, and AWS paths require real credentials.
- Some audit artifacts and standards gates are still tracked as gaps.

## Docs And Evidence Checked

This pass checked 67 hand-authored doc or metadata files, 208 test files, and 4 workflow files on `main`. The count excludes vendored provider licenses, dependency folders, generated cache files, and large generated artifact history.

Large content groups were counted rather than listed file by file:

- `backend/src/data/plant-care-corpus/`: 11 files
- `docs/standards/`: 12 files

Primary docs checked:

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `CHANGELOG.md`
- `CITATION.cff`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `README.md`
- `SECURITY.md`
- `backend/tests/integration/README.md`
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
- Plus 12 more files in the same inventory.

Representative test files checked:

- `backend/tests/eval/ragRetrieval.eval.test.ts`
- `backend/tests/integration/critical-path.test.ts`
- `backend/tests/integration/local-server.test.ts`
- `backend/tests/integration/notification-dispatch.test.ts`
- `backend/tests/integration/propagation-share.test.ts`
- `backend/tests/integration/real-handler.test.ts`
- `backend/tests/integration/route-parity.test.ts`
- `backend/tests/integration/route-terraform-parity.test.ts`
- `backend/tests/integration/sitter-links.test.ts`
- `backend/tests/unit/handlers/api.test.ts`
- `backend/tests/unit/handlers/auth.test.ts`
- `backend/tests/unit/handlers/billing.test.ts`
- `backend/tests/unit/handlers/chatStreamHandler.test.ts`
- `backend/tests/unit/handlers/climate.test.ts`
- `backend/tests/unit/handlers/health.test.ts`
- `backend/tests/unit/handlers/households.test.ts`
- `backend/tests/unit/handlers/identify.test.ts`
- `backend/tests/unit/handlers/import.test.ts`
- `backend/tests/unit/handlers/me.test.ts`
- `backend/tests/unit/handlers/notifications.test.ts`
- `backend/tests/unit/handlers/plantHealthCheck.test.ts`
- `backend/tests/unit/handlers/plantShare.test.ts`
- `backend/tests/unit/handlers/plants.test.ts`
- `backend/tests/unit/handlers/sitter.test.ts`
- `backend/tests/unit/handlers/species.test.ts`
- `backend/tests/unit/handlers/tasks.test.ts`
- `backend/tests/unit/middleware/apiKey.test.ts`
- `backend/tests/unit/middleware/auth.test.ts`
- `backend/tests/unit/middleware/bodySize.test.ts`
- `backend/tests/unit/middleware/errorHandler.test.ts`
- `backend/tests/unit/middleware/rateLimit.test.ts`
- `backend/tests/unit/middleware/router.test.ts`
- `backend/tests/unit/middleware/securityHeaders.test.ts`
- `backend/tests/unit/middleware/validation.test.ts`
- `backend/tests/unit/models/petToxicity.test.ts`
- `backend/tests/unit/models/plans.test.ts`
- `backend/tests/unit/models/schemas.test.ts`
- `backend/tests/unit/models/taskTemplates.test.ts`
- `backend/tests/unit/services/activity.test.ts`
- `backend/tests/unit/services/apiKeys.test.ts`
- `backend/tests/unit/services/billing.test.ts`
- `backend/tests/unit/services/careRecommendations.test.ts`
- `backend/tests/unit/services/chat.test.ts`
- `backend/tests/unit/services/chatBedrock.test.ts`
- `backend/tests/unit/services/chatBedrockStream.test.ts`
- Plus 163 more test files.

## Validation Notes

For this docs PR, validation means the scope file was generated from the clean `origin/main` worktree, reviewed against repo metadata and docs inventory, and checked with `git diff --check`. Project test suites are still the authority for code behavior, because this PR changes documentation only.
