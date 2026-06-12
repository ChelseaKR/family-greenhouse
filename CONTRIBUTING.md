# Contributing to Family Greenhouse

A collaborative plant-care app for households. This is how we make changes here.

## Setup

Node 20+, npm 10+. From the repo root:

```bash
npm install                       # installs across all workspaces
npm --workspace backend run dev   # local Express mock at :4000 (seeds a household)
npm --workspace frontend run dev  # Vite dev server at :3000
```

Sign in at http://localhost:3000 with `test@example.com` / `password123`.

## The change workflow

1. **Branch off `main`** — `fix/…`, `feat/…`, `chore/…`, `docs/…`, `ci/…`.
2. Make the change. Match the surrounding code's style, comment density, and idioms.
3. **Open a PR to `main`.** CI must pass.
4. Squash-merge (the history is one commit per PR).

`main` is the deploy branch: a `v*` tag deploys production; merges are the unit of review.

## Quality gates (don't fight them — they catch real things)

Three tiers, all enforced:

- **pre-commit** (husky + lint-staged): ESLint + Prettier on changed files.
- **pre-push**: `npm run typecheck` + `npm test` (full suite).
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, frontend+backend tests, Semgrep SAST, gitleaks, `npm audit`, terraform validate, build, Lighthouse, bundle-size, Playwright e2e + a11y.

Run locally before pushing: `npm run typecheck && npm run lint && npm test`.

## Commit messages — conventional commits (enforced by commitlint)

```
type(scope): subject in lowercase, ≤100 chars
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build` `revert`. **The subject must be lowercase** (commitlint rejects `Bump` / capitalized first words — a common Dependabot-PR gotcha). Body explains _why_, not _what_.

## Conventions that matter

- **TypeScript is strict.** No `any` escape hatches; no `@ts-ignore` (the one exception is `local-server.ts`, the dev-only mock).
- **Validate at the boundary.** Every request body goes through a Zod schema (`backend/src/models/schemas.ts`); never trust input.
- **Integrations degrade, never throw.** Perenual/Plant.id/OpenWeather/SES/SNS return `null`/log-line on failure so the app stays usable. Keep that pattern.
- **DynamoDB is one table.** New access patterns are PK/SK/GSI design decisions — see [`docs/architecture.md`](docs/architecture.md) and write an ADR if it's non-obvious.
- **New API route?** Add the `// METHOD /path` handler comment, the Terraform route, and the OpenAPI entry — `scripts/check-api-spec.mjs` (in CI) fails on drift.
- **Accessibility is a release gate.** WCAG 2.2 AA, enforced by axe + Lighthouse in CI. See [`docs/accessibility.md`](docs/accessibility.md).
- **No secrets in the repo.** gitleaks is blocking. Secrets go in AWS Secrets Manager / Lambda env / GitHub secrets.

## Architecture decisions

Significant or non-obvious decisions get an ADR — see [`docs/adr/`](docs/adr/). Add one (copy the template) when you make a choice a future contributor would otherwise have to reverse-engineer.

## Docs you'll want

`docs/development.md` (dev loop), `docs/architecture.md` (how it fits together), `docs/deployment.md`, `docs/testing.md`, `docs/runbooks.md` + `docs/incidents.md` (when prod breaks), `docs/compliance.md`.
