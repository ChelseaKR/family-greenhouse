# Local development

A two-terminal setup gets you running with no external dependencies. Every external service (Cognito, S3, Stripe, SES, SNS, Plant.id, Sentry) has a local fallback that doesn't require credentials.

## Prerequisites

- Node 20.x or later
- npm 10.x or later

That's it for the inner loop. AWS CLI and Terraform are only needed if you're deploying.

## First-time setup

```bash
git clone <repo>
cd family-greenhouse
npm install                  # installs all workspaces
```

The Husky pre-commit hook is wired up by the `prepare` script that runs on install — it lints staged files via `lint-staged` and validates commit messages via `commitlint`.

## Running the app

Two terminals:

```bash
# Terminal 1 — backend mock server on :4000
npm --workspace backend run dev

# Terminal 2 — Vite dev server on :3000
npm --workspace frontend run dev
```

Open http://localhost:3000. The dev server seeds:

- One user: `test@example.com` / `password123`
- One household ("Test Household") with the user as admin
- One plant ("Monstera") with one task

For new signups, the confirmation code is always `123456`. Forgot-password reset code is also `123456`.

## What's running

The backend runs from `backend/src/local-server.ts`, which is an Express app that mirrors the production Lambda handlers route-for-route, body-shape-for-body-shape. It uses in-memory `Map`s for storage — restart it and you're back to the seed.

This is intentional. Production runs the Lambda code in `backend/src/handlers/*` against real AWS services; the Express server is a faithful enough replica that:

- Frontend code is unaware of which one it's talking to
- Integration tests exercise the same routing and validation logic via supertest
- Bugs that show up in dev are usually real production bugs (this is how we found the 415-on-GET and the JWT-uuid bug both)

## Adding a new endpoint

1. **Schema** — add a Zod schema to `backend/src/models/schemas.ts` if there's a request body.
2. **Service** — add the data-access function to `backend/src/services/{resource}.ts`. Pure DDB calls, no business logic at the request boundary.
3. **Lambda handler** — add the entry point to `backend/src/handlers/{resource}/handler.ts`, wired through `createHandler` and the appropriate auth middleware.
4. **Local-server route** — mirror it in `backend/src/local-server.ts` so the dev server doesn't fall behind.
5. **Frontend service** — add the typed call to `frontend/src/services/{resource}Service.ts`.
6. **Tests** — at least a handler unit test (mock the service) and an integration test against the local-server (supertest).

Whichever direction you start from, write the test second — the supertest integration test is fast feedback and exercises the actual mock server.

## Common scripts

All scripts run via npm workspaces. From the repo root:

```bash
npm test                                    # all tests, both workspaces
npm run typecheck                           # strict TS, both workspaces
npm run lint                                # eslint, both workspaces
npm run format                              # prettier
npm run format:check                        # prettier --check (CI uses this)

# Backend specifics
npm --workspace backend run test:watch
npm --workspace backend run test:coverage
npm --workspace backend run dev             # tsx watch on local-server.ts
npm --workspace backend run build           # esbuild bundle for Lambda

# Frontend specifics
npm --workspace frontend run test:watch
npm --workspace frontend run test:e2e       # playwright
npm --workspace frontend run test:e2e:ui    # playwright UI
npm --workspace frontend run build          # vite production build
npm --workspace frontend run preview        # serve the production build locally
```

## Environment variables

Almost nothing is required for local dev. The frontend will use `http://localhost:4000` for the API by default. Optional vars:

| Variable                    | Effect                                                       |
| --------------------------- | ------------------------------------------------------------ |
| `VITE_API_URL`              | Override backend URL for the Vite dev server                 |
| `VITE_SENTRY_DSN`           | Enable frontend Sentry (no-op when unset)                    |
| `VITE_VAPID_PUBLIC_KEY`     | Enable web-push subscription on Settings → Notifications     |
| `VITE_GIT_SHA`              | Sentry release tag                                           |
| `PLANT_ID_API_KEY`          | Real Plant.id calls (otherwise demo suggestions)             |
| `SES_FROM_EMAIL`            | Real email sends via SES (otherwise dry-run logs)            |
| `SMS_NOTIFICATIONS_ENABLED` | Set to `1` to actually send SMS via SNS (otherwise dry-run)  |
| `STRIPE_SECRET_KEY` (prod)  | Real Stripe checkout (local-server bypasses Stripe entirely) |

For the full production set, see [`deployment.md`](deployment.md).

## Debugging tips

- **Frontend 401 → 401 loop**: usually a stale access token + a backend that doesn't accept it. Check the browser network tab; the response interceptor should call `/auth/refresh` once and retry. If it doesn't, log out and log back in.
- **Backend prints noisy `[email dry-run]` lines**: that's the notifier telling you SES isn't configured. Set `SES_FROM_EMAIL` if you want real sends, or ignore them.
- **Tests pass locally but fail in CI**: usually a date/timezone test (we hit one already; see `tests/unit/utils/date.test.ts` for the timezone-safe pattern), or a test that depends on file ordering.
- **Vitest picks up Playwright e2e specs and explodes**: `vitest.config.ts` excludes `tests/e2e/**`. If you add a new e2e folder, make sure it's also excluded.

## Where to read next

- [`testing.md`](testing.md) for how the test pyramid is organised
- [`architecture.md`](architecture.md) if you want a tour of the data model
- [`deployment.md`](deployment.md) when you're ready to push to AWS
