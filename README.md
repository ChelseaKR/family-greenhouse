# Family Greenhouse

A collaborative plant-care app for households. People share a household, add plants, schedule recurring tasks (water, fertilize, prune…), and get reminders across browser, email, and SMS so nobody has to ask "did you water the Monstera?" ever again.

Built with React + TypeScript on the frontend and AWS Lambda + DynamoDB + Cognito on the backend, plus a local Express dev server that mirrors the API surface so you can develop entirely offline.

> _In loving memory of my mom, Joyce - who taught us to keep growing. 🌱_

## What's in here

```
family-greenhouse/
├── frontend/         React + Vite SPA
├── backend/          Lambda handlers + a local Express mock that mirrors them
├── infrastructure/   Terraform stack (network, Cognito, DDB, S3, API Gateway, CloudFront)
├── docs/             Detailed docs — start with development.md if you're new
├── scripts/          One-off shell helpers
├── .github/          CI + CD workflows
└── package.json      npm workspaces root
```

## Quickstart for developers

You need Node 20+ and npm 10+. From the repo root:

```bash
npm install                       # installs across all workspaces

# Two terminals:
npm --workspace backend run dev   # local Express mock at :4000
npm --workspace frontend run dev  # Vite dev server at :3000
```

Open http://localhost:3000 and sign in with `test@example.com` / `password123` — the dev server seeds a household for you on boot.

For everything else (running tests, deploying, configuring channels) follow the deeper docs:

- [`docs/development.md`](docs/development.md) — local dev workflow, where to add a new endpoint
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit, single-table DDB layout, request lifecycle
- [`docs/deployment.md`](docs/deployment.md) — from-zero AWS deploy
- [`docs/testing.md`](docs/testing.md) — the test pyramid we run + how to add to it
- [`docs/notifications.md`](docs/notifications.md) — browser, email, SMS, web-push details
- [`docs/billing.md`](docs/billing.md) — Stripe integration, plan caps, webhook flow
- [`docs/public-api.md`](docs/public-api.md) — read-only public API: key auth, scopes, rate limits, endpoints
- [`docs/production-checklist.md`](docs/production-checklist.md) — gating list for going live
- [`docs/incidents.md`](docs/incidents.md) — severity levels, the first 15 minutes, post-mortem template
- [`docs/runbooks.md`](docs/runbooks.md) — step-by-step fixes (rollback, DDB throttle, Stripe webhooks, PITR…)
- [`docs/support.md`](docs/support.md) — user-issue triage + common resolutions

## What works today

Headline features that are wired end-to-end:

- **Households**: invite-link based, role-aware (admin/member), enforced via Cognito custom claims
- **Plants**: CRUD, photo upload (with S3 presigned URL race-fixed), species autocomplete from a curated catalog, plant-name shuffle, optional Plant.id-powered identification from a photo
- **Tasks**: types (water/fertilize/prune/repot/custom), recurring frequency, complete/snooze/edit, assigned-to lookups
- **Care history**: per-plant + household activity feed
- **Notifications**: browser pop-ups, web push (VAPID), email (SES), SMS (SNS) — each one configurable per user under Settings → Notifications
- **Subscriptions**: Stripe-backed Seedling/Garden/Greenhouse tiers; plan caps enforced server-side; in-app upgrade flow with Stripe Checkout + customer portal

What needs real infra credentials to leave demo mode is enumerated in [`docs/production-checklist.md`](docs/production-checklist.md). Every channel/integration falls back gracefully to a structured log line when its env var isn't set, so you don't need a single key to develop locally.

## Day-to-day commands

```bash
npm test                                      # everything (workspaces)
npm --workspace backend run test:watch        # vitest watch on backend
npm --workspace frontend run test:e2e         # Playwright (boots both servers)
npm run typecheck                             # strict TS across both workspaces
npm run lint                                  # eslint across both workspaces
npm run format                                # prettier
```

## Contributing

Branches off `main`, conventional-commits style messages, PR with passing CI:

```
feat(plants): add identification from photo
fix(billing): clamp price-id env lookup
docs: rewrite README
```

Types we use: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`. The commitlint hook in `.husky/` will reject anything else.

## License

[Elastic License 2.0](LICENSE) — the source is free to read, run, modify, and
self-host for your own household. What it doesn't allow is offering Family
Greenhouse (or a substantial copy of it) to others as a hosted/managed
service. If that's something you want to do, get in touch:
support@familygreenhouse.net.
