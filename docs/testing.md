# Testing

The test suite is organised as a pyramid: many fast unit tests, a smaller integration layer that exercises the local Express server end-to-end, and a thin Playwright layer for cross-browser smoke tests.

## Counts at a glance

<!-- prettier-ignore-start -->
<!-- BEGIN:TEST-COUNTS (checked by scripts/check-docs-testing.mjs — update the
     file counts here when you add or remove a test FILE, or the gate fails) -->

| Layer                     | Tool               | Where                                                                     | Files | Test cases |
| ------------------------- | ------------------ | ------------------------------------------------------------------------- | ----- | ---------- |
| Backend unit              | vitest             | `backend/tests/unit/{config,handlers,middleware,models,services,utils}`   | 91    | 1,306      |
| Backend integration       | vitest + supertest | `backend/tests/integration/`                                              | 8     | 199        |
| Backend RAG eval          | vitest             | `backend/tests/eval/`                                                     | 1     | 7          |
| Frontend unit + component | vitest + RTL + MSW | `frontend/tests/unit/`                                                    | 101   | 732        |
| Frontend colocated unit   | vitest             | `frontend/src/**/*.test.ts`                                               | 11    | 44         |
| Frontend integration      | vitest + RTL + MSW | `frontend/tests/integration/`                                             | 1     | 1          |
| Frontend e2e              | Playwright         | `frontend/tests/e2e/`                                                     | 24    | see below  |

<!-- END:TEST-COUNTS -->
<!-- prettier-ignore-end -->

**2,289 vitest cases** across 213 files — 1,512 backend, 777 frontend. The backend suite runs in ~17s and the frontend in ~80s (jsdom, serial by config).

Of the 24 Playwright specs, 22 run in the cross-browser matrix (Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari — five projects). `post-deploy-smoke.spec.ts` and `store-screenshots.spec.ts` are excluded by `testIgnore` and run only from their own workflows.

The **file** counts above are enforced by `scripts/check-docs-testing.mjs` (part of `npm run verify` and of CI's Lint job), so this table cannot silently rot the way it did before — it once claimed ~300 total cases against an actual 2,176, and described the integration layer as a single file when there were eight. The **test-case** counts are a dated snapshot (re-measured 2026-08-29, Node 26.7.0 locally — CI pins Node 22 via .nvmrc, vitest 4.1.11) because collecting them means running the suites; reproduce with:

```bash
npm --workspace backend exec vitest list | wc -l
npm --workspace frontend exec vitest list | wc -l
```

## Running tests

From the repo root:

```bash
npm test                                    # everything
npm --workspace backend run test            # backend only
npm --workspace frontend run test           # frontend only
npm --workspace backend run test:watch      # interactive
npm --workspace backend run test:coverage   # produces an HTML report under coverage/
npm --workspace frontend run test:e2e       # Playwright; auto-boots both servers
npm --workspace frontend run test:e2e:ui    # Playwright UI mode
```

Both vitest configs default to `NODE_ENV=test`, which:

- Silences the `pino` logger
- Causes `requireEnv()` to return a sentinel string instead of throwing
- Stops `local-server.ts` from calling `app.listen` (so `import { app }` is safe)

## Backend unit tests

Tests in `backend/tests/unit/` mock the AWS SDK at the module level and use dynamic imports so the mocks are in effect before the production code runs:

```ts
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  GetCommand: vi.fn((input) => ({ input, kind: 'Get' })),
  // ...
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

it('createPlant writes a Put with the right key', async () => {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const { createPlant } = await import('../../../src/services/plantService.js');
  vi.mocked(dynamodb.send).mockResolvedValueOnce({});
  await createPlant({ name: 'Pothos' }, 'hh-1', 'user-1');
  // assert on the captured command
});
```

For handler tests, mock the **service** layer rather than DynamoDB directly — that way you're testing the handler's HTTP behaviour, not re-testing the service.

For middleware tests, build minimal `APIGatewayProxyEvent` shapes and run them through a `middy(handler).use(yourMiddleware)` pipeline.

Not every file there mocks something. `backend/tests/unit/config/` also holds structural tests over committed repository artifacts — `commercialStatus.test.ts` reads the production Terraform and workflows, and `branchRuleset.test.ts` reads `.github/rulesets/main.json` and fails if the committed branch ruleset would lock the repository owner out when applied (empty, absent, wrong-type, wrong-actor, or PR-only `bypass_actors`). Its loader fails closed on a missing or unparseable file, because a guard that passes when its subject is absent is the defect it exists to catch; see [`.github/rulesets/README.md`](../.github/rulesets/README.md).

## Backend integration tests

`backend/tests/integration/` holds eight suites, not one. `local-server.test.ts`
is the largest; alongside it sit `critical-path.test.ts`,
`notification-dispatch.test.ts`, `propagation-share.test.ts`,
`real-handler.test.ts` (runs the genuine middy handler + auth middleware rather
than the Express stand-in), `route-parity.test.ts`,
`route-terraform-parity.test.ts`, and `sitter-links.test.ts`. The parity suites
are structural: they assert every declared route exists in the handler layer and
in Terraform, so a route can't be added in one place and forgotten in the other.

The shared pattern boots the Express app via supertest and exercises real HTTP
request/response cycles:

```ts
beforeEach(() => resetDb());

it('GET /plants/:id returns upcomingTasks', async () => {
  const token = await loginAsSeed();
  const res = await request(app)
    .get(`/plants/${seedPlantId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.upcomingTasks)).toBe(true);
});
```

The seed data is reset between tests via `resetDb()` from `local-server.ts`. Use this layer for:

- Wiring tests (does the route exist? does middleware fire in the right order?)
- Cross-resource flows (direct test fixture → login → create household → add plant)
- Split commercial-status controls (free `/auth/signup`, paid activity disabled,
  `/register`, and Cognito self-signup policy)
- Regression tests for bugs we've previously hit (the JWT-uuid bug, the upcomingTasks shape mismatch)

## Frontend unit tests

`frontend/tests/unit/` is organised by kind:

1. **Pure utils** — `utils/` — date helpers, plant-name generator, species search. No DOM, just functions.
2. **Components** — `components/` — Button, Input, ProtectedRoute. React Testing Library + jest-dom matchers.
3. **Service layer** — `services/` — axios clients tested against MSW handlers, including the 401-refresh interceptor.
4. **Features** — `features/` — whole pages and cards rendered inside their routes and providers. The largest group by far.
5. **Hooks, store, i18n, a11y, lib, config** — `hooks/`, `store/`, `i18n/`, `a11y/`, `lib/`, `config/`.

A smaller set of unit tests live **beside the code** as `frontend/src/**/*.test.ts`
(the vitest `include` covers both locations). Prefer `tests/unit/` for new work;
the colocated ones are mostly pure modules whose test reads better next to them.

MSW server is set up once in `tests/setup.ts` and per-test handlers go on `server.use(...)`. The setup file also installs an in-memory localStorage so zustand persist works in jsdom.

Tests reset the auth store between cases:

```ts
// tests/setup.ts
beforeEach(async () => {
  globalThis.localStorage.clear();
  const { useAuthStore } = await import('@/store/authStore');
  useAuthStore.setState({
    user: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
  });
});
```

## End-to-end

Playwright runs against the real Vite dev server + the real Express mock backend. The config at `frontend/playwright.config.ts` boots both webservers automatically:

```ts
webServer: [
  { command: 'npm --workspace backend run dev', url: 'http://localhost:4000/health', cwd: '..' },
  { command: 'npm run dev', url: 'http://localhost:3000' },
],
```

Twenty-two specs run across Chromium, Firefox, WebKit, Mobile Chrome and Mobile
Safari. They fall into four groups:

- **Golden paths** — `auth`, `happy-path`, `plant-crud`, `create-plant`, `task-completion`, `register-flow`, `join-second-household`, `space-overview`, `shared-care-pulse`, `pricing-interval`, `integration-functionality`, `no-care-data`
- **Accessibility** — `a11y` and `a11y-authenticated` (axe over public and authenticated routes), plus `keyboard-path`, `reflow`, and `reduced-motion`
- **Rendering** — `visual` and `visual-regression` (screenshot baselines, committed per browser under `*-snapshots/`), `responsive-ux`
- **Notifications** — `notification-browser-surfaces`, `foreground-notification-timing`

Two further specs are excluded from this matrix by `testIgnore` and run only
from their own workflows: `post-deploy-smoke.spec.ts` (production CD, described
below) and `store-screenshots.spec.ts` (mobile store assets, via
`npm run mobile:release`).

Playwright still isn't where behaviour is specified — RTL and the vitest suites
cover that. Playwright covers cross-browser rendering, accessibility, and "did
we break the boot path?".

The production workflow also runs `post-deploy-smoke.spec.ts` with one Chromium
worker. One disposable account goes through the live `/register` form and real
`POST /auth/signup` endpoint until Cognito reports it `UNCONFIRMED`; a separate
admin-created confirmed account exercises login, onboarding, the dashboard,
plant creation, image presigning, a non-empty S3 PUT, image confirmation, and
the rendered image response/decoded width. Authenticated teardown first calls
the real `DELETE /me` path (which owns S3 photo cleanup), then runs idempotent
Cognito/DynamoDB admin cleanup and verifies the fixture partitions are empty.
A final independent fallback parses the exact bucket/key from the presign,
paginates that one object&rsquo;s S3 Versions and DeleteMarkers, permanently
deletes them, and re-lists to prove zero residue. Every cleanup branch is
attempted even when an earlier one fails; flows that fail before presign make no
S3 calls. Failure diagnostics retain only response hostname/status or a safe AWS
error class so presigned URL credentials cannot be written to CI output or
reports. The deployed-smoke config therefore disables Playwright network traces
(which archive full URLs); failure screenshots and video remain enabled.

## Date / timezone tests

`new Date('2024-04-15')` parses as UTC midnight. In any negative-offset timezone (e.g. PT in April → UTC-7), `.getDate()` returns 14, not 15. We hit this bug in the original `addDays` test and fixed it by using local-time constructors:

```ts
// good — unambiguous local 2024-04-15
const date = new Date(2024, 3, 15);

// bad — UTC parse, gets shifted in negative offset zones
const date = new Date('2024-04-15');
```

Use the local-time constructor unless you're explicitly testing UTC behaviour, in which case construct the date with an explicit `Z` suffix and `getUTCDate()`.

## Adding a new test

For a backend handler:

1. Add a unit test in `backend/tests/unit/handlers/{resource}.test.ts` mocking the services
2. Add an integration test in `backend/tests/integration/local-server.test.ts` that hits the new route via supertest

For a frontend feature:

1. If it's a service call → unit test with MSW
2. If it's a component → RTL test rendering it inside the routes/providers it needs
3. If it's a critical golden-path flow → add a Playwright spec; otherwise no

## Coverage

Vitest's v8 coverage is **configured and enforced**. Per-workspace floors live in
`backend/vitest.config.ts` and `frontend/vitest.config.ts`, and a run that falls
below any of them exits non-zero:

<!-- prettier-ignore-start -->
<!-- BEGIN:COVERAGE-THRESHOLDS (checked by scripts/check-docs-testing.mjs
     against the two vitest configs — change them there, then here) -->

| Workspace | Lines | Statements | Branches | Functions |
| --------- | ----- | ---------- | -------- | --------- |
| Backend   | 82    | 81         | 74       | 82        |
| Frontend  | 76    | 75         | 65       | 66        |

<!-- END:COVERAGE-THRESHOLDS -->
<!-- prettier-ignore-end -->

Those floors are enforced in three places, all running the same command:

- **CI** — the required `Test Backend` and `Test Frontend` jobs run `npm run test:coverage`, so a PR that drops below a floor cannot merge.
- **Pre-push** — `.husky/pre-push` runs `npm run verify`, which chains `test:coverage`.
- **Locally** — `npm run verify`, or a single workspace:

```bash
npm --workspace backend run test:coverage
open backend/coverage/index.html
```

The floors are set a couple of points below the last measurement rather than at
the portfolio's 80×4 target, and they **ratchet upward release over release** —
that obligation is CQ-16 / P1-5, described in the README's
[Standards conformance](../README.md#standards-conformance) section and in the
`thresholds` comments in both vitest configs. Lower a floor only with a tracked
issue explaining why; the whole point of a ratchet is that it does not slide
back.

Percent-coverage gates do get gamed, which is why the floors sit below the real
measurement and are not the only gate: CI also fails visibly when a critical
area regresses (auth, billing, notifications). Add tests to those areas first
when you change them.
