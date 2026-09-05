# Testing

The test suite is organised as a pyramid: many fast unit tests, a smaller integration layer that exercises the local Express server end-to-end, and a thin Playwright layer for cross-browser smoke tests.

## Counts at a glance

<!-- prettier-ignore-start -->
<!-- BEGIN:TEST-COUNTS (checked by scripts/check-docs-testing.mjs — every layer the
     script counts must have a row here naming the path it lives at. File counts
     are deliberately not written down; see the note below the table) -->

| Layer                         | Tool               | Where                                                                           | Test cases |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------- | ---------- |
| Backend unit                  | vitest             | `backend/tests/unit/{config,handlers,middleware,models,scripts,services,utils}` | 1,501      |
| Backend integration           | vitest + supertest | `backend/tests/integration/`                                                    | 199        |
| Backend RAG + pet-safety eval | vitest             | `backend/tests/eval/`                                                           | 73         |
| Frontend unit + component     | vitest + RTL + MSW | `frontend/tests/unit/`                                                          | 781        |
| Frontend colocated unit       | vitest             | `frontend/src/**/*.test.ts`                                                     | 78         |
| Frontend integration          | vitest + RTL + MSW | `frontend/tests/integration/`                                                   | 1          |
| Frontend e2e                  | Playwright         | `frontend/tests/e2e/`                                                           | see below  |

<!-- END:TEST-COUNTS -->
<!-- prettier-ignore-end -->

**2,633 vitest cases** — 1,773 backend, 860 frontend — as of 2026-09-02. The backend suite runs in ~17s. The frontend suite runs its files in parallel across a worker-thread pool (`frontend/vitest.config.ts`); it took ~80s here when it ran them one at a time, and roughly a quarter of that once spread across cores. Each file still gets its own jsdom and module registry, and coverage is still collected over the whole suite in one process, so the floors below mean what they say.

All Playwright specs but two run in the cross-browser matrix (Chromium, Firefox, WebKit, Mobile Chrome, Mobile Safari — five projects). `post-deploy-smoke.spec.ts` and `store-screenshots.spec.ts` are excluded by `testIgnore` and run only from their own workflows.

**File counts are derived, not documented.** `node scripts/check-docs-testing.mjs --print` prints the live per-layer file counts from the filesystem. They used to be written into this table and enforced by the gate, which kept them honest but made every PR that added a test file rewrite the same two lines: on 2026-09-03 nine open PRs were unmergeable on this file alone, and the correct post-merge number was on none of them. The gate (part of `npm run verify` and of CI's Lint job) now enforces the part a reader relies on — every layer the script counts has a row here at the path it actually lives at, and the coverage floors and enforcement claims below match the configs — and refuses a `Files` column or an "across N files" total so the conflict surface cannot come back. That row-per-layer check is what stops the drift this table used to have, when it described the integration layer as a single file while there were eight, and claimed ~300 total cases against an actual 2,176.

The **test-case** counts are a dated snapshot (re-measured 2026-09-02, Node 26.8.1 locally — CI pins Node 22 via .nvmrc, vitest 4.1.11) because collecting them means running the suites. Don't bump them per PR — that is the other half of the same conflict surface. Re-measure them when cutting a release, with:

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

Playwright runs against the real production bundle (`vite preview`, not `vite dev` — the dev server's Firefox parser uses `eval`, which our production CSP correctly blocks) plus the real Express mock backend. The config at `frontend/playwright.config.ts` boots both webservers automatically:

```ts
webServer: [
  {
    command: 'ALLOW_TEST_ACCOUNT_PROVISIONING=1 npm --workspace backend run dev',
    url: 'http://localhost:4000/health',
    cwd: '..',
  },
  { command: 'npm run build && npm run preview', url: 'http://localhost:3000' },
],
```

**Sharding.** CI splits the suite across four runners with Playwright's
`--shard=N/4`, each at one worker. One worker per shard is deliberate: the local
backend boots a single in-memory DB, so specs touching the shared seed account
(`test@example.com`) race each other if they run concurrently against the _same_
server — the collision documented at the top of `tests/e2e/helpers.ts`. Separate
shards are separate runners with separate backends and separate seeds, so
partitioning across them is safe where raising in-job workers would not be.

Shards publish `--reporter=blob` output that the `E2E report (merged)` job merges
back into one `playwright-report/`, printing the executed and skipped totals as
it goes. The required `E2E + accessibility (Playwright)` check is an aggregate
job that fails unless every shard succeeded.

Twenty-two specs run across Chromium, Firefox, WebKit, Mobile Chrome and Mobile
Safari. They fall into four groups:

- **Golden paths** — `auth`, `happy-path`, `plant-crud`, `create-plant`, `task-completion`, `register-flow`, `join-second-household`, `space-overview`, `shared-care-pulse`, `pricing-interval`, `integration-functionality`, `no-care-data`
- **Accessibility** — `a11y` and `a11y-authenticated` (axe over public and authenticated routes), plus `keyboard-path`, `reflow`, and `reduced-motion`
- **Rendering** — `visual` and `responsive-ux`. Also `visual-regression`
  (screenshot baselines, committed per browser under `*-snapshots/`) — but
  read the next paragraph before counting it as coverage.
- **Notifications** — `notification-browser-surfaces`, `foreground-notification-timing`

> **`visual-regression` does not execute in CI.** Every committed baseline is
> `*-darwin.png` and the runners are Linux, so the spec skips itself on
> `process.env.CI` (`visual-regression.spec.ts:30`) and
> `.github/workflows/e2e-crossbrowser.yml` skips it for the same reason. It
> therefore contributes nothing to the required
> `E2E + accessibility (Playwright)` check that contains it — a required check
> with a no-op inside. The deferral is deliberate and documented in the spec;
> what was not documented is this line, which listed the suite as live
> coverage. Lifting it means generating five browser variants across five pages
> on a Linux runner and committing them. `scripts/check-no-silenced-gates.mjs`
> now scans specs for this pattern, so the next one has to be argued for rather
> than merely added.

Two further specs are excluded from this matrix by `testIgnore` and run only
from their own workflows: `post-deploy-smoke.spec.ts` (production CD, described
below) and `store-screenshots.spec.ts` (mobile store assets, via
`npm run mobile:release`).

> **The e2e tree is statically checked, and that is not the same as being run.**
> `frontend/tests/e2e/**` and `playwright.config.ts` used to sit outside every
> static gate: `tsconfig.json` includes only `src`, the lint script was scoped to
> `src`, and `testIgnore` keeps the two specs above out of PR CI. So the spec
> that can revert a production release was compiled by nothing, linted by
> nothing, and executed only by production (#440). They are now in
> `frontend/tsconfig.e2e.json` and the frontend lint globs, and `npm run
smoke:parse` loads the smoke spec through Playwright's runner (`--list`) in
> both `npm run verify` and CI's `Type Check` job. Switching the checks on found
> two live defects: a helper typed `APIResponse` that all six callers invoked
> with a page `Response`, and a `use.reducedMotion` key that Playwright 1.62
> silently ignores — measured, the browser reported
> `prefers-reduced-motion: reduce` as **false** until it moved to
> `contextOptions`.
>
> What none of this can catch is a **stale assertion**: `toHaveURL(/\/dashboard$/)`
> parses and lints perfectly after the destination has moved, which is precisely
> what happened in #394 / PR #439. Deciding whether a stale smoke assertion
> should still auto-roll-back a good release is tracked separately in #440.

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

### Fixtures are marked, and swept when teardown never runs

That teardown is careful and complete, and it still leaked. On 2026-09-04 the
production table held 38 households, 35 of them left by smoke runs whose
teardown never executed — a skipped job, a cancelled run, a dead runner. Against
two real registered users, 92% of the household count was test debris, and
nothing anywhere excluded it. Two additions close that:

- **A structural marker, written at creation.** Every fixture row carries
  `isTestFixture: true` plus `testFixtureRunId`, `testFixtureCreatedAt`, and
  `testFixtureSource`. `TEST_FIXTURE` in `post-deploy-smoke-support.ts` is the
  contract. It is an attribute, not a name: matching the string "Smoke Test
  Household" would delete a real household the day somebody chose that name.
  Anything that counts households can now exclude fixtures without this script.
- **A claim row, written before the browser flow starts.**
  `TESTFIXTURE#<runId> / METADATA` records the fixture's Cognito `sub`, so a run
  that dies between "POST /households returned 201" and "the stamp landed" is
  still traceable — the sweeper follows GSI1 from that `sub` to every household
  the fixture joined. It carries no TTL on purpose: expiring the claim would
  strand the very rows it is there to find. Teardown deletes it last, only once
  the partitions it indexes verify empty.

`scripts/sweep-test-fixtures.mjs` does the cleanup that does not depend on the
run finishing. It is a **dry run by default** — it prints what it would delete
and exits without touching anything — and needs `--apply` to act. It deletes
only partitions reachable from a marked row, only fixtures older than
`--min-age-hours` (default 3), refuses a plan above `--max-deletes`, re-checks
every key against an allow-list of partition prefixes, and **skips any household
holding a member who is not a fixture user**, reporting it rather than deleting
it. The `sweep-test-fixtures` job in `cd-production.yml` runs it with `--apply`
on every production deploy, under `if: always()` so that a failed, skipped, or
cancelled smoke job still gets cleaned up by the next release.

Rows created before the markers existed carry neither, so they cannot be swept
by rule. `--include-legacy --user-pool-id <id>` proposes them on evidence — a
household whose every member row's Cognito user is gone from the pool, older
than the age gate — never on its name. Review the dry run, then re-run with
`--apply`. The deploy job never passes `--include-legacy`; clearing the backlog
is deliberately an operator action.

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
| Backend   | 87    | 86         | 78       | 89        |
| Frontend  | 76    | 75         | 65       | 66        |

<!-- END:COVERAGE-THRESHOLDS -->
<!-- prettier-ignore-end -->

### The CloudFront edge function

`frontend/scripts/spa-router.test.mjs` (`npm run test:edge`, `node --test`) covers
`infrastructure/modules/frontend/functions/spa-router.js` — the viewer-request
function that maps `/pricing` and the other prerendered routes onto their
`index.html` objects. It is not a vitest suite, so it is a separate step rather
than part of `test:coverage`: it runs in CI's `Test Frontend` job and as a step
in `npm run verify`.

It used to run in neither. The suite existed and passed, its own header comment
said it was "part of the frontend test gate", and a repo-wide grep for
`test:edge` returned only that comment and its `package.json` line. On
2026-09-04 the untested function returned 403 for every route but `/` for about
forty minutes. `scripts/check-test-scripts-run.mjs` now fails the build if any
`test*` script is run by neither the gate nor a workflow without a registered
reason (#472).

The same file now also covers the routing decision itself. Since #615 the
function resolves every non-prerendered route to `/app-shell.html` **by name**
rather than rewriting it to a key that does not exist and letting CloudFront's
`custom_error_response` rescue the 403 — which is what frees a missing
`/assets/` object to answer 404 instead of the app shell. That makes a bug in
this function an outage rather than a degradation, so the suite enumerates
every kind of path the distribution serves, asserts the generated route map
still matches `frontend/scripts/public-routes.mjs`, and asserts the source
stays inside CloudFront's 10 KB function limit — the map grows by one line per
blog post, and failing a gate is cheaper than failing a `terraform apply`.

### The production availability predicates

`scripts/synthetic-page-check.test.mjs` (`npm run test:checks`, `node --test`)
covers the pure predicates in `scripts/synthetic-page-check.mjs`. That script
only ever runs against a live origin — the fifteen-minute `uptime.yml` cron and
the post-deploy smoke — so until #615 no pre-merge gate executed a line of it.
Its `--expect-failure` negative control proves the check as a whole can still
fail, which is real but coarse: any single assertion failing satisfies it, so
an assertion that quietly stopped meaning anything would be invisible behind
the others. These tests pin the two that decide whether a `/assets/` response
is a served JavaScript bundle or the SPA shell standing in for a chunk that is
not there, in both directions. Runs in CI's `Test Frontend` job and in
`npm run verify`.

Those floors are enforced in three places, all running the same command:

- **CI** — the required `Test Backend` and `Test Frontend` jobs run `npm run test:coverage`, so a PR that drops below a floor cannot merge.
- **Pre-push** — `.githooks/pre-push` runs `npm run verify`, which chains `test:coverage`.
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
