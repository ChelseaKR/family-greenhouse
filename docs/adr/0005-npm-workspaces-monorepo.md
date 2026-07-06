# 0005 — npm-workspaces monorepo layout

**Status:** Accepted (2026-07, backfilled — the layout has been in place since the repo's first commit)

## Context

`frontend/`, `backend/`, and `infrastructure/` live in one repository instead of three. Frontend and backend are independently deployable (separate Lambda zips / S3+CloudFront bundle) but share a release cadence (one tag deploys both), a single CI pipeline, and a handful of conventions (TypeScript strict mode, ESLint flat config, Zod-at-the-boundary) that are easiest to keep in sync when they're one `npm ci` away from each other. `infrastructure/` is Terraform, not an npm workspace, but lives alongside the two workspaces because a single tag's deploy touches all three.

Alternatives considered:

- **Separate repos** (frontend, backend, infra) — rejected: this is a single-maintainer product where frontend/backend land in the same PR more often than not (e.g. a new API route needs a handler, a service method, and a frontend call in one change). Cross-repo PRs for a one-person team is pure overhead.
- **Turborepo/Nx** — rejected as unnecessary: two workspaces with no shared build graph beyond "build frontend, build backend" don't need a task orchestrator. Plain `npm workspaces` + `--workspaces --if-present` scripts (see root `package.json`) cover it.

## Decision

Keep `frontend/` and `backend/` as npm workspaces under one root `package.json` (workspaces: `["frontend", "backend"]`), each with its own `tsconfig.json`, `eslint.config.mjs`, and `vitest.config.ts`. Root-level scripts (`lint`, `typecheck`, `test`, `build`, `verify`) fan out via `--workspaces --if-present`. `infrastructure/` stays a plain Terraform directory (not an npm workspace — it has no `package.json`).

## Consequences

- One `npm ci` at the root installs everything; one lockfile (`package-lock.json`) covers the whole dependency graph — simplifies `npm audit`/Renovate/Dependabot but means a bad transitive bump in one workspace can (rarely) collide with the other's peer-dependency resolution.
- Root `eslint.config.mjs` currently mirrors the two workspace configs rather than sharing one module (tracked as CQ-25 — extract a shared config, see the P2/P3 remediation backlog).
- CI runs lint/typecheck/test per-workspace (`working-directory: frontend|backend`) rather than at the root, so a change in one workspace doesn't need to wait on the other's build.
- Any future workspace (e.g. a shared `packages/types` for cross-workspace DTOs) slots into the same `workspaces` array with no restructuring.
