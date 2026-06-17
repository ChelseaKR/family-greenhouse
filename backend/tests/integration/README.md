# Backend integration tests

There are two integration-test styles in this directory. New tests should
prefer the **real-handler** style.

## Real-handler tests (preferred) — `real-handler.test.ts`

These invoke the **actual exported Lambda handlers** through the **actual
production middy middleware chain** (auth, validation, rate-limit, CORS,
security headers, JSON error shaping) and run the **real services**. Only the
AWS SDK boundary is faked.

- **`support/invokeHandler.ts`** — builds a synthetic `APIGatewayProxyEvent`
  (method, route key, path/query params, headers, body, and a Cognito identity
  forwarded as the API Gateway authorizer claims) and invokes a real handler —
  either a single per-route middy handler (`tasksHandler.createTask`) or a group
  router (`tasksHandler.handler`). Returns the parsed `{ statusCode, body,
headers }`. Auth uses the same seam the unit tests do: pass an `identity`
  (`{ userId, email, householdId? }`) and the real `authMiddleware` validates it
  against the membership row. Omit `identity` to assert the 401 path.

- **`support/inMemoryDynamo.ts`** — a small in-memory single-table DynamoDB that
  backs `dynamodb.send(command)`. It implements exactly the command/expression
  dialect the services use (single-table keys, GSI1/GSI2, conditional writes,
  `TransactWrite` with per-item `CancellationReasons`, `if_not_exists` counters).
  Anything outside that dialect throws a loud `UnsupportedExpressionError` rather
  than silently mis-evaluating, so a new expression form fails the test with a
  clear pointer instead of a false pass.

- **`support/seed.ts`** — seeds households/members/plants by calling the real
  services, so seeded rows can never drift from what the handlers read back.

Wire it up in a test file like this:

```ts
const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
// in beforeEach: store.reset(); reset the membership cache.
```

### Why this exists

The other integration suites run against `src/local-server.ts`, a ~3,300-line
hand-maintained Express **clone** of every production route. That clone
reimplements auth, validation, household-scoping, and error shaping a second
time, so the **real** middy handler stack is never exercised end-to-end
in-process and the two implementations can silently drift. The real-handler
adapter closes that gap: a test can prove, e.g., that the **real** auth
middleware re-validates an `X-Household-Id` override against the membership
table and 403s a non-member — a bug class the clone structurally cannot catch.

### Extending it

- **New route?** Add a real-handler test here. Import the route's exported
  handler, seed the rows it reads, invoke it with an `identity`, assert the
  response. Prefer this over adding to the local-server clone.
- **New service DDB expression form?** If a test fails with
  `UnsupportedExpressionError`, extend `inMemoryDynamo.ts` to cover the new
  form (and only that form) — keep it a faithful mirror, not a general emulator.
- **A flow that needs heavy non-DDB mocking** (Cognito sign-up, S3 object
  copies, Stripe webhooks): seed the prerequisite state via `support/seed.ts`
  or the service directly and test the handler logic that follows, or leave it
  on the local-server suite and note why. The currently-ported flows are the
  auth/household boundary, task create→complete idempotency, and plan-cap
  enforcement; the plant-share accept flow is a good next candidate (it needs
  the S3 image-copy step stubbed).

## Local-server tests — `critical-path.test.ts`, `propagation-share.test.ts`, …

These drive `src/local-server.ts` via supertest. They remain valuable and are
NOT going away:

- `local-server.ts` is also the dev server the frontend e2e/Playwright suite
  runs against, so it has to stay correct regardless.
- `route-parity.test.ts` / `route-terraform-parity.test.ts` assert the clone
  and the Terraform route table both cover every production route — keeping the
  clone honest.

Keep both styles green. The real-handler suite is additive: it raises coverage
of the production middleware/handler stack without dropping the clone's.
