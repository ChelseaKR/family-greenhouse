# Contributing to Family Greenhouse

A collaborative plant-care app for households. This is how we make changes here.

## Setup

Node 22+ (see `.nvmrc`), npm 10+. From the repo root:

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
- **pre-push**: `npm run verify` (the full local gate below, including both workspaces' coverage floors).
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, frontend+backend tests, Semgrep SAST, gitleaks, `npm audit`, terraform validate, build, Lighthouse, bundle-size, Playwright e2e + a11y.

Run locally before pushing: `make verify` (the portfolio-standard entry point, which runs `npm run verify`) — the same stages CI runs: `format:check`, `lint`, `typecheck`, `test:coverage`, `i18n:check`, `reads:check`, `observability:check`, `npm audit (--omit=dev --audit-level=high)`, the bare-marker / silenced-gate / docs-testing guards, and the figures, API-spec, sitemap and brand checks. `test:coverage` is `vitest run --coverage` in both workspaces, so the coverage floors that gate `Test Frontend` / `Test Backend` are enforced locally too, not only in CI. `.husky/pre-push` already calls it.

Those steps run **concurrently**, not as a chain — `scripts/run-gate.mjs` schedules the list in [`scripts/gate-steps.mjs`](scripts/gate-steps.mjs) across the machine's cores, and the run fails if any single step does, naming it and reprinting its output. Nothing is skipped or sampled; it is the same set of checks, overlapped. Notes for when it misbehaves:

- Each step's output is buffered and shown only if that step fails. `npm run verify -- --verbose` prints all of it.
- On an already-busy machine, narrow the pool: `GATE_JOBS=2 git push`, or `npm run verify -- --jobs 2`. `--jobs 1` is close to the old serial behaviour.
- Adding a workspace, or renaming a script a gate step runs, fails the gate with an explanation rather than silently dropping the check. Add the step to `scripts/gate-steps.mjs`.

This repo is onboarded to the portfolio's `docs/standards/` (vendored, pinned `v1.0.1`) — see the README `## Standards conformance` table for per-standard state and [`docs/RESPONSIBLE-TECH-AUDITS.md`](docs/RESPONSIBLE-TECH-AUDITS.md) for the detail. A change that touches AI/chat, adds a new external API, or changes what PII the app collects should update the relevant declaration in the same PR.

## Commit messages — conventional commits (enforced by commitlint)

```
type(scope): subject in lowercase, ≤100 chars
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build` `revert`. **The subject must be lowercase** (commitlint rejects `Bump` / capitalized first words — a common Dependabot-PR gotcha). Body explains _why_, not _what_.

## Conventions that matter

- **TypeScript is strict.** No `any` escape hatches; no `@ts-ignore` (the one exception is `local-server.ts`, the dev-only mock).
- **Validate at the boundary.** Every request body goes through a Zod schema (`backend/src/models/schemas.ts`); never trust input.
- **Integrations degrade, never throw.** Perenual/Plant.id/OpenWeather/SES/SNS return `null`/log-line on failure so the app stays usable. Keep that pattern.
- **A read has three outcomes, not two.** In flight, settled with data, and settled with no data are different, and the third one must be rendered as itself — never as a `0`, an empty list, or an absent card. An absent card is read as an all-clear nobody computed. `npm run reads:check` (in `verify` and CI's `Lint`) ratchets the shapes it can detect mechanically in both workspaces — `frontend/scripts/check-settled-read-states.mjs` for `useQuery` results, `backend/scripts/check-settled-read-states.mjs` for DynamoDB / SSM / Cognito / `fetch` reads whose catch hands back a zero, an empty list, or the same default a genuine empty produces; the rule and each gate's limits are [ADR 0010](docs/adr/0010-settled-read-states.md).
- **DynamoDB is one table.** New access patterns are PK/SK/GSI design decisions — see [`docs/architecture.md`](docs/architecture.md) and write an ADR if it's non-obvious.
- **New API route?** Add the `// METHOD /path` handler comment, the Terraform route, and the OpenAPI entry — `scripts/check-api-spec.mjs` (in CI) fails on drift.
- **Accessibility is a release gate.** WCAG 2.2 AA, enforced by axe + Lighthouse in CI. See [`docs/accessibility.md`](docs/accessibility.md).
- **No secrets in the repo.** gitleaks is blocking. Secrets go in AWS Secrets Manager / Lambda env / GitHub secrets.

## Architecture decisions

Significant or non-obvious decisions get an ADR — see [`docs/adr/`](docs/adr/). Add one (copy the template) when you make a choice a future contributor would otherwise have to reverse-engineer.

## Docs you'll want

`docs/development.md` (dev loop), `docs/architecture.md` (how it fits together), `docs/deployment.md`, `docs/testing.md`, `docs/runbooks.md` + `docs/incidents.md` (when prod breaks), `docs/compliance.md`.
