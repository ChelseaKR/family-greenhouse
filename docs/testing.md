# Testing

The test suite is organised as a pyramid: many fast unit tests, a smaller integration layer that exercises the local Express server end-to-end, and a thin Playwright layer for cross-browser smoke tests.

## Counts at a glance

| Layer                     | Tool               | Where                                                            | Approx count          |
| ------------------------- | ------------------ | ---------------------------------------------------------------- | --------------------- |
| Backend unit              | vitest             | `backend/tests/unit/{handlers,services,middleware,utils,models}` | ~150                  |
| Backend integration       | vitest + supertest | `backend/tests/integration/local-server.test.ts`                 | ~55                   |
| Frontend unit + component | vitest + RTL + MSW | `frontend/tests/unit/`                                           | ~75                   |
| Frontend e2e              | Playwright         | `frontend/tests/e2e/`                                            | ~9 specs × 5 browsers |

Total around 300+ test cases at the time of writing. They run in well under a minute combined.

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

## Backend integration tests

`local-server.test.ts` boots the Express app via supertest and exercises real HTTP request/response cycles:

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

Three flavours:

1. **Pure utils** — `tests/unit/utils/` — date helpers, plant-name generator, species search. No DOM, just functions.
2. **Components** — `tests/unit/components/` — Button, Input, ProtectedRoute. React Testing Library + jest-dom matchers.
3. **Service layer** — `tests/unit/services/` — axios clients tested against MSW handlers, including the 401-refresh interceptor.

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

We run a small set of golden-path tests across Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari. Specifically:

- Auth page validation
- Login → dashboard → plant detail (the page that previously crashed; now a regression test)
- Bad credentials shows an error and stays on `/login`

This isn't a comprehensive UI suite. The goal is "did we break the boot path?" — RTL tests cover behaviour, Playwright covers cross-browser rendering.

The production workflow also runs `post-deploy-smoke.spec.ts` with one Chromium
worker. One disposable account goes through the live `/register` form and real
`POST /auth/signup` endpoint until Cognito reports it `UNCONFIRMED`; a separate
admin-created confirmed account exercises login, onboarding, and the dashboard.
Teardown deletes both Cognito users and the authenticated fixture's household
rows, so the public-signup check is not bypassed by the admin fixture.

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

Vitest's v8 coverage is configured but not enforced. Run it ad-hoc:

```bash
npm --workspace backend run test:coverage
open backend/coverage/index.html
```

We don't gate CI on coverage % because the metric tends to be gamed. We DO gate on tests passing and on CI failing visibly when a critical area regresses (auth, billing, notifications). Add tests to those areas first when you change them.
