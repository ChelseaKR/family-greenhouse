/**
 * Credentials at rest and in flight (#450), through the REAL handlers.
 *
 * Six credentials travel in a URL and nowhere else: a plant tag, a sitter link,
 * a kiosk link, a caretaker seat, a cutting share, and (already hashed before
 * this) a calendar feed. Each is the person's only key, so each has to be safe
 * in four places, and this file drives every one of them end to end and asserts
 * all four:
 *
 *   1. AT REST   — creation stores a digest and only a digest. The table, dumped
 *                  whole, never contains the token.
 *   2. IN FLIGHT — the token is in the creation response and in NO other
 *                  response body or header: not a list, not a scan, not a
 *                  revoke, not an error.
 *   3. IN LOGS   — no log line the handlers and their middleware wrote (request,
 *                  response, error, audit, upgrade) contains it. The logger is
 *                  the real one, with its real redaction, writing to a buffer.
 *   4. EXISTENCE — a token that never existed, one that is revoked, one that is
 *                  malformed and a digest lifted from a table dump all get the
 *                  SAME status and body, so the public routes are not an oracle
 *                  for which tokens exist.
 *
 * And the migration: a credential written before hashing (plaintext key,
 * plaintext attribute — the shape the old code wrote) still resolves, is moved
 * to its hashed key by the first request that uses it, and is not in the table
 * afterwards. Nothing the person holds changes.
 *
 * The negative controls at the bottom prove the assertions CAN fail: a table
 * that stores plaintext, and a log line that carries a token, are each caught.
 * (The source-level controls — revert the fix, watch this file go red — are in
 * the pull request that added it.)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler, type InvokeResult, type TestIdentity } from './support/invokeHandler.js';
import { seedHousehold, seedPlant, setHouseholdPlan } from './support/seed.js';
import { hashCapabilityToken, type TokenHashSurface } from '../../src/utils/tokenHash.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));

// The REAL logger, redaction and all, writing to a buffer instead of stdout.
// Every module that logs (the request middleware, `audit`, the services) imports
// `logger` / `withRequest` from here, so one buffer holds everything a request
// wrote.
const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/logger.js')>();
  const logger = actual.createLogger({ write: (chunk: string) => void logged.lines.push(chunk) });
  logger.level = 'trace';
  return { ...actual, logger, withRequest: (ctx: object) => logger.child(ctx) };
});

// Cognito is not the subject; the sitter-link handler asks it for a display name.
vi.mock('../../src/services/cognitoUsers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/cognitoUsers.js')>();
  return { ...actual, getUserName: vi.fn(async () => 'Ada Admin') };
});

const ADMIN = { userId: 'user-admin', email: 'admin@example.com', name: 'Ada Admin' };
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

let householdId: string;
let plantId: string;
let taskId: string;
let admin: TestIdentity;

/** Every NON-creation response of the test in progress: the surface a token
 *  must never appear on. */
const observed: Array<{ label: string; res: InvokeResult }> = [];

beforeAll(() => {
  process.env.FRONTEND_URL = 'https://greenhouse.example.test';
});

beforeEach(async () => {
  store.reset();
  logged.lines.length = 0;
  observed.length = 0;
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();

  const seeded = await seedHousehold(store, { name: 'Leak Test Home', admin: ADMIN });
  householdId = seeded.householdId;
  await setHouseholdPlan(store, householdId, 'greenhouse');
  admin = { ...ADMIN, householdId, householdRole: 'admin' };
  plantId = (await seedPlant(store, householdId, ADMIN.userId, { name: 'Monstera' })).id;

  const tasks = await import('../../src/handlers/tasks/handler.js');
  const created = await invokeHandler(tasks.createTask, {
    method: 'POST',
    routeKey: 'POST /tasks',
    identity: admin,
    body: { plantId, type: 'water', frequency: 7 },
  });
  expect(created.statusCode).toBe(201);
  taskId = (created.body as { id: string }).id;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = Parameters<typeof invokeHandler>[0];
type CallOptions = Parameters<typeof invokeHandler>[1];

/** Drive one request and remember its response as one a token must not be in.
 *  Only the credential's own CREATION goes through `create()` instead. */
async function call(label: string, handler: Handler, options: CallOptions): Promise<InvokeResult> {
  const res = await invokeHandler(handler, options);
  observed.push({ label, res });
  return res;
}

/** The one response allowed to carry the token. */
async function create(handler: Handler, options: CallOptions): Promise<InvokeResult> {
  return invokeHandler(handler, options);
}

const tableDump = () => JSON.stringify(store.all());
const logDump = () => logged.lines.join('');

/** AT REST: the table, dumped whole, does not contain the token; and a row is
 *  stored under the credential's digest. Throws (rather than expects) so a
 *  negative control can prove it fails. */
function assertHashedOnlyAtRest(
  secret: string,
  surface: TokenHashSurface,
  prefix: string,
  /** Where the digest is the key: the partition key, or an index key (calendar). */
  keyAttribute: 'PK' | 'GSI1PK' = 'PK'
): void {
  if (tableDump().includes(secret)) {
    throw new Error('the token is stored in the table in plaintext');
  }
  const key = `${prefix}${hashCapabilityToken(surface, secret)}`;
  if (!store.all().some((row) => row[keyAttribute] === key)) {
    throw new Error(`no row is stored under the token's digest (${prefix}…)`);
  }
}

/** IN FLIGHT and IN LOGS: the secret is in no response we observed and no log
 *  line written. Throws so a negative control can prove it fails. */
function assertNeverLeaked(secret: string): void {
  for (const { label, res } of observed) {
    const wire = JSON.stringify({
      statusCode: res.statusCode,
      body: res.body,
      headers: res.headers,
    });
    if (wire.includes(secret)) throw new Error(`the token is in the response to: ${label}`);
  }
  if (logDump().includes(secret)) throw new Error('the token is in a log line');
}

/** Non-vacuous: the logger really was on, and really saw the requests. */
function assertLoggingWasOn(...placeholders: string[]): void {
  const output = logDump();
  expect(output.length).toBeGreaterThan(0);
  for (const placeholder of placeholders) expect(output).toContain(placeholder);
}

const hex64 = (seed: string) => seed.repeat(64 / seed.length).slice(0, 64);
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** What the client is told about a failure, minus anything per-request. */
const failureOf = (res: InvokeResult) => ({
  statusCode: res.statusCode,
  body: res.body,
  headers: res.headers,
});

// ---------------------------------------------------------------------------
// Plant tags
// ---------------------------------------------------------------------------

describe('plant tags', () => {
  const routes = {
    issue: 'POST /plants/{plantId}/tag',
    list: 'GET /households/{id}/plant-tags',
    scan: 'GET /tag/{token}',
    complete: 'POST /tag/{token}/tasks/{taskId}/complete',
    revoke: 'DELETE /plants/{plantId}/tag',
    pin: 'PUT /households/{id}/plant-tags/pin',
  } as const;

  async function tagsHandler() {
    return (await import('../../src/handlers/plantTags/handler.js')).handler;
  }

  const scan = async (token: string, headers: Record<string, string> = {}) =>
    call(`scan /tag/${token.slice(0, 6)}…`, await tagsHandler(), {
      method: 'GET',
      routeKey: routes.scan,
      path: `/tag/${token}`,
      pathParameters: { token },
      headers,
    });

  async function issue() {
    const res = await create(await tagsHandler(), {
      method: 'POST',
      routeKey: routes.issue,
      path: `/plants/${plantId}/tag`,
      pathParameters: { plantId },
      identity: admin,
    });
    expect(res.statusCode).toBe(201);
    return res.body as { token: string; url: string; id: string };
  }

  /** The row exactly as the pre-#450 code wrote it. */
  function seedLegacyTag(token: string, overrides: Record<string, unknown> = {}) {
    store.put({
      PK: `PLANTTAG#${token}`,
      SK: 'METADATA',
      GSI1PK: `HOUSEHOLD#${householdId}#PLANTTAG`,
      GSI1SK: '2026-06-01T00:00:00.000Z',
      entityType: 'PlantTag',
      id: 'legacy-tag-1',
      token,
      householdId,
      plantId,
      createdBy: ADMIN.userId,
      createdAt: '2026-06-01T00:00:00.000Z',
      status: 'active',
      revokedAt: null,
      pinFailures: 0,
      pinLockedUntil: null,
      ...overrides,
    });
  }

  it('creation stores only a digest, and the token appears nowhere after the creation response', async () => {
    const handler = await tagsHandler();
    const tag = await issue();
    expect(tag.token).toMatch(HEX64);
    expect(tag.url).toBe(`https://greenhouse.example.test/tag/${tag.token}`);
    assertHashedOnlyAtRest(tag.token, 'plantTag', 'PLANTTAG#');

    // Everything a person can do with it, and everything that can be asked about it.
    const list = await call('list tags', handler, {
      method: 'GET',
      routeKey: routes.list,
      path: `/households/${householdId}/plant-tags`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(list.statusCode).toBe(200);
    const listed = (list.body as { tags: Array<{ token: string | null; url: string | null }> })
      .tags;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ token: null, url: null });

    await call('set pin', handler, {
      method: 'PUT',
      routeKey: routes.pin,
      path: `/households/${householdId}/plant-tags/pin`,
      pathParameters: { id: householdId },
      identity: admin,
      body: { pin: '4321' },
    });
    expect((await scan(tag.token, { 'x-tag-pin': '4321' })).statusCode).toBe(200);
    expect((await scan(tag.token, { 'x-tag-pin': '0000' })).statusCode).toBe(401);
    expect((await scan(tag.token)).statusCode).toBe(401);
    const done = await call('complete via tag', handler, {
      method: 'POST',
      routeKey: routes.complete,
      path: `/tag/${tag.token}/tasks/${taskId}/complete`,
      pathParameters: { token: tag.token, taskId },
      headers: { 'x-tag-pin': '4321' },
      body: { displayName: 'Grandma' },
    });
    expect(done.statusCode).toBe(200);
    const revoked = await call('revoke tag', handler, {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/plants/${plantId}/tag`,
      pathParameters: { plantId },
      identity: admin,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await scan(tag.token, { 'x-tag-pin': '4321' })).statusCode).toBe(404);

    assertLoggingWasOn('/tag/{token}', 'planttag.issued', 'planttag.listed');
    assertHashedOnlyAtRest(tag.token, 'plantTag', 'PLANTTAG#');
    assertNeverLeaked(tag.token);
  });

  it('a token that never existed, a revoked one, a malformed one and a digest all answer the same', async () => {
    const handler = await tagsHandler();
    const tag = await issue();
    await call('revoke tag', handler, {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/plants/${plantId}/tag`,
      pathParameters: { plantId },
      identity: admin,
    });
    const live = await issue(); // a second, live tag whose digest is in the dump
    const digest = hashCapabilityToken('plantTag', live.token);
    expect(store.all().some((row) => row.PK === `PLANTTAG#${digest}`)).toBe(true);

    const revoked = await scan(tag.token);
    const unknown = await scan(hex64('ab12'));
    const malformed = await scan('not-a-token');
    const digestAsToken = await scan(digest);
    expect(unknown.statusCode).toBe(404);
    for (const other of [revoked, malformed, digestAsToken]) {
      expect(failureOf(other)).toEqual(failureOf(unknown));
    }
    // And the live one really does scan, so the four above are refusals of
    // something that is not it, not a route that is simply down.
    expect((await scan(live.token)).statusCode).toBe(200);
  });

  it('a label printed before hashing still scans, and its first scan moves it to its hashed key', async () => {
    const token = hex64('fe01');
    seedLegacyTag(token);
    expect(tableDump()).toContain(token); // sanity: this really is the legacy shape
    const rowsBefore = store.all().length;

    const first = await scan(token);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ plantName: 'Monstera' });

    // Moved, not copied — and nothing the person holds changed.
    expect(store.all().length).toBe(rowsBefore);
    assertHashedOnlyAtRest(token, 'plantTag', 'PLANTTAG#');

    // Once: the second scan is a plain hashed read.
    const sends = vi.spyOn(store.client, 'send');
    expect((await scan(token)).statusCode).toBe(200);
    const kinds = sends.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    expect(kinds).not.toContain('TransactWriteCommand');
    sends.mockRestore();

    assertLoggingWasOn('credential.lazy_upgrade', '/tag/{token}');
    assertNeverLeaked(token);
  });

  it('the print sheet returns a pre-#450 label’s code only until that row is moved (the one documented exception)', async () => {
    // #811's transition: until a legacy row is re-keyed it still holds its
    // token, and the print sheet may still print it. That ends for a given
    // label at its first scan (or the operator backfill) — after which the same
    // list answers null. This pins the exception so it cannot widen.
    const token = hex64('fe05');
    seedLegacyTag(token);
    // Deliberately NOT through `call()`: this response is the documented
    // exception, so it must not be counted among the ones a token may not be in.
    const listTags = async () =>
      JSON.stringify(
        (
          await invokeHandler(await tagsHandler(), {
            method: 'GET',
            routeKey: routes.list,
            path: `/households/${householdId}/plant-tags`,
            pathParameters: { id: householdId },
            identity: admin,
          })
        ).body
      );
    expect(await listTags()).toContain(token);

    expect((await scan(token)).statusCode).toBe(200); // first use moves it
    expect(await listTags()).not.toContain(token);
    assertNeverLeaked(token);
  });

  it('a legacy label behind a PIN: the wrong-PIN write in the FIRST request lands on the moved row', async () => {
    const token = hex64('fe02');
    seedLegacyTag(token);
    await call('set pin', await tagsHandler(), {
      method: 'PUT',
      routeKey: routes.pin,
      path: `/households/${householdId}/plant-tags/pin`,
      pathParameters: { id: householdId },
      identity: admin,
      body: { pin: '1357' },
    });

    // The request upgrades the row, then counts a wrong PIN against it. If the
    // handler kept addressing the legacy key this is a 500.
    const wrong = await scan(token, { 'x-tag-pin': '0000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toMatchObject({ details: { reason: 'wrong' } });
    const moved = store
      .all()
      .find((row) => row.PK === `PLANTTAG#${hashCapabilityToken('plantTag', token)}`);
    expect(moved?.pinFailures).toBe(1);

    expect((await scan(token, { 'x-tag-pin': '1357' })).statusCode).toBe(200);
    assertNeverLeaked(token);
  });

  it('a legacy label can be re-issued: the old label stops, and the row that stops is the moved one', async () => {
    const token = hex64('fe03');
    seedLegacyTag(token);
    expect((await scan(token)).statusCode).toBe(200); // upgraded by its first use

    const replacement = await issue(); // revokes this plant's previous tag
    expect((await scan(token)).statusCode).toBe(404);
    expect((await scan(replacement.token)).statusCode).toBe(200);
    assertNeverLeaked(token);
    assertNeverLeaked(replacement.token);
  });

  it('a revoked legacy label stays revoked when it is scanned (the move never resurrects it)', async () => {
    const token = hex64('fe04');
    seedLegacyTag(token, { status: 'revoked', revokedAt: '2026-09-01T00:00:00.000Z' });
    const unknown = await scan(hex64('cd34'));
    const res = await scan(token);
    expect(failureOf(res)).toEqual(failureOf(unknown));
    assertNeverLeaked(token);
  });
});

// ---------------------------------------------------------------------------
// Sitter links
// ---------------------------------------------------------------------------

describe('sitter links', () => {
  const routes = {
    create: 'POST /households/{id}/sitter-links',
    list: 'GET /households/{id}/sitter-links',
    revoke: 'DELETE /households/{id}/sitter-links/{linkId}',
    view: 'GET /sitter/{token}',
    complete: 'POST /sitter/{token}/tasks/{taskId}/complete',
  } as const;

  const households = async () => (await import('../../src/handlers/households/handler.js')).handler;
  const tasks = async () => (await import('../../src/handlers/tasks/handler.js')).handler;

  const view = async (token: string) =>
    call(`sitter view ${token.slice(0, 6)}…`, await tasks(), {
      method: 'GET',
      routeKey: routes.view,
      path: `/sitter/${token}`,
      pathParameters: { token },
    });

  async function createLink() {
    const res = await create(await households(), {
      method: 'POST',
      routeKey: routes.create,
      path: `/households/${householdId}/sitter-links`,
      pathParameters: { id: householdId },
      identity: admin,
      body: { expiresAt: future(5), label: 'Neighbor' },
    });
    expect(res.statusCode).toBe(201);
    return res.body as { token: string; url: string; id: string };
  }

  it('creation stores only a digest, and the token appears nowhere after the creation response', async () => {
    const link = await createLink();
    expect(link.token).toMatch(HEX64);
    expect(link.url).toBe(`https://greenhouse.example.test/sit/${link.token}`);
    assertHashedOnlyAtRest(link.token, 'sitterLink', 'SITTER#');

    const list = await call('list sitter links', await households(), {
      method: 'GET',
      routeKey: routes.list,
      path: `/households/${householdId}/sitter-links`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(list.statusCode).toBe(200);

    const seen = await view(link.token);
    expect(seen.statusCode).toBe(200);
    const done = await call('complete via sitter', await tasks(), {
      method: 'POST',
      routeKey: routes.complete,
      path: `/sitter/${link.token}/tasks/${taskId}/complete`,
      pathParameters: { token: link.token, taskId },
      body: {},
    });
    expect(done.statusCode).toBe(200);

    const revoked = await call('revoke sitter link', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/sitter-links/${link.id}`,
      pathParameters: { id: householdId, linkId: link.id },
      identity: admin,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await view(link.token)).statusCode).toBe(404);

    assertLoggingWasOn('/sitter/{token}', 'household.member_added');
    assertHashedOnlyAtRest(link.token, 'sitterLink', 'SITTER#');
    assertNeverLeaked(link.token);
  });

  it('unknown, revoked, malformed, expired and digest tokens all answer the same', async () => {
    const revokedLink = await createLink();
    await call('revoke', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/sitter-links/${revokedLink.id}`,
      pathParameters: { id: householdId, linkId: revokedLink.id },
      identity: admin,
    });
    const live = await createLink();
    const digest = hashCapabilityToken('sitterLink', live.token);
    const expiredToken = hex64('e0e0');
    store.put({
      PK: `SITTER#${hashCapabilityToken('sitterLink', expiredToken)}`,
      SK: 'METADATA',
      GSI1PK: `HOUSEHOLD#${householdId}#SITTER`,
      entityType: 'SitterLink',
      id: 'expired-1',
      tokenHash: hashCapabilityToken('sitterLink', expiredToken),
      householdId,
      createdBy: ADMIN.userId,
      createdAt: past(20),
      startsAt: past(20),
      expiresAt: past(2),
      status: 'active',
      label: null,
    });

    const unknown = await view(hex64('ab12'));
    expect(unknown.statusCode).toBe(404);
    for (const token of [revokedLink.token, 'short', digest, expiredToken]) {
      expect(failureOf(await view(token))).toEqual(failureOf(unknown));
    }
    expect((await view(live.token)).statusCode).toBe(200);
  });

  it('a link sent before hashing still opens, and its first use moves it to its hashed key', async () => {
    const token = hex64('5177');
    store.put({
      PK: `SITTER#${token}`,
      SK: 'METADATA',
      GSI1PK: `HOUSEHOLD#${householdId}#SITTER`,
      GSI1SK: past(1),
      entityType: 'SitterLink',
      id: 'legacy-sitter-1',
      token,
      householdId,
      createdBy: ADMIN.userId,
      createdAt: past(1),
      startsAt: past(1),
      expiresAt: future(6),
      status: 'active',
      label: 'Old link',
      photoCount: 1,
      ttl: 9_999_999_999,
    });
    const rowsBefore = store.all().length;

    // Not yet used, so still plaintext at rest: the management list must not
    // hand it out (its `token` and `keyToken` are the secret on a legacy row).
    const listed = await call('list sitter links', await households(), {
      method: 'GET',
      routeKey: routes.list,
      path: `/households/${householdId}/sitter-links`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.body)).toContain('legacy-sitter-1');
    assertNeverLeaked(token);

    expect((await view(token)).statusCode).toBe(200);
    expect(store.all().length).toBe(rowsBefore);
    assertHashedOnlyAtRest(token, 'sitterLink', 'SITTER#');
    // Its quota counter travelled with it.
    const moved = store
      .all()
      .find((row) => row.PK === `SITTER#${hashCapabilityToken('sitterLink', token)}`);
    expect(moved?.photoCount).toBe(1);

    // The management list still finds it, and revoking it (which addresses the
    // row by its own key) turns the very same link off.
    const revoke = await call('revoke moved link', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/sitter-links/legacy-sitter-1`,
      pathParameters: { id: householdId, linkId: 'legacy-sitter-1' },
      identity: admin,
    });
    expect(revoke.statusCode).toBe(204);
    expect((await view(token)).statusCode).toBe(404);
    assertNeverLeaked(token);
  });
});

// ---------------------------------------------------------------------------
// Kiosk links
// ---------------------------------------------------------------------------

describe('kiosk links', () => {
  const routes = {
    issue: 'POST /households/{id}/kiosk-link',
    get: 'GET /households/{id}/kiosk-link',
    revoke: 'DELETE /households/{id}/kiosk-link',
    view: 'GET /kiosk/{token}',
    complete: 'POST /kiosk/{token}/tasks/{taskId}/complete',
  } as const;

  const households = async () => (await import('../../src/handlers/households/handler.js')).handler;
  const tasks = async () => (await import('../../src/handlers/tasks/handler.js')).handler;

  const view = async (token: string) =>
    call(`kiosk view ${token.slice(0, 6)}…`, await tasks(), {
      method: 'GET',
      routeKey: routes.view,
      path: `/kiosk/${token}`,
      pathParameters: { token },
    });

  async function issueLink() {
    const res = await create(await households(), {
      method: 'POST',
      routeKey: routes.issue,
      path: `/households/${householdId}/kiosk-link`,
      pathParameters: { id: householdId },
      identity: admin,
      body: {},
    });
    expect(res.statusCode).toBe(201);
    return res.body as { token: string; url: string; id: string };
  }

  it('creation stores only a digest, and the token appears nowhere after the creation response', async () => {
    const link = await issueLink();
    expect(link.token).toMatch(HEX64);
    assertHashedOnlyAtRest(link.token, 'kioskLink', 'KIOSK#');

    const status = await call('get kiosk link', await households(), {
      method: 'GET',
      routeKey: routes.get,
      path: `/households/${householdId}/kiosk-link`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(status.statusCode).toBe(200);
    expect((await view(link.token)).statusCode).toBe(200);
    const done = await call('complete via kiosk', await tasks(), {
      method: 'POST',
      routeKey: routes.complete,
      path: `/kiosk/${link.token}/tasks/${taskId}/complete`,
      pathParameters: { token: link.token, taskId },
      body: {},
    });
    expect(done.statusCode).toBe(200);

    // Re-issuing is the household's remedy for a photographed screen: the old
    // token stops on the very next poll.
    const reissued = await issueLink();
    expect((await view(link.token)).statusCode).toBe(404);
    expect((await view(reissued.token)).statusCode).toBe(200);

    const revoked = await call('revoke kiosk link', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/kiosk-link`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await view(reissued.token)).statusCode).toBe(404);

    assertLoggingWasOn('/kiosk/{token}', 'household.member_added');
    for (const token of [link.token, reissued.token]) {
      assertHashedOnlyAtRest(token, 'kioskLink', 'KIOSK#');
      assertNeverLeaked(token);
    }
  });

  it('unknown, revoked, malformed and digest tokens all answer the same', async () => {
    const first = await issueLink();
    const live = await issueLink(); // revokes `first`
    const digest = hashCapabilityToken('kioskLink', live.token);

    const unknown = await view(hex64('ab12'));
    expect(unknown.statusCode).toBe(404);
    for (const token of [first.token, 'short', digest]) {
      expect(failureOf(await view(token))).toEqual(failureOf(unknown));
    }
    expect((await view(live.token)).statusCode).toBe(200);
  });

  it('a wall display set up before hashing keeps working, and its first poll moves it', async () => {
    const token = hex64('4105');
    store.put({
      PK: `KIOSK#${token}`,
      SK: 'METADATA',
      GSI1PK: `HOUSEHOLD#${householdId}#KIOSK`,
      GSI1SK: '2026-08-01T00:00:00.000Z',
      entityType: 'KioskLink',
      id: 'legacy-kiosk-1',
      token,
      householdId,
      createdBy: ADMIN.userId,
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'active',
      pollIntervalSeconds: 300,
    });
    const rowsBefore = store.all().length;

    const status = await call('get kiosk link', await households(), {
      method: 'GET',
      routeKey: routes.get,
      path: `/households/${householdId}/kiosk-link`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.body)).toContain('legacy-kiosk-1');
    assertNeverLeaked(token);

    const first = await view(token);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ pollIntervalSeconds: 300 });
    expect(store.all().length).toBe(rowsBefore);
    assertHashedOnlyAtRest(token, 'kioskLink', 'KIOSK#');

    // The management screen still finds the moved row, and revoking it works.
    const revoked = await call('revoke kiosk link', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/kiosk-link`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await view(token)).statusCode).toBe(404);
    assertNeverLeaked(token);
  });
});

// ---------------------------------------------------------------------------
// Caretaker seats
// ---------------------------------------------------------------------------

describe('caretaker seats', () => {
  const routes = {
    create: 'POST /households/{id}/caretakers',
    list: 'GET /households/{id}/caretakers',
    revoke: 'DELETE /households/{id}/caretakers/{caretakerId}',
    view: 'GET /caretaker/{token}',
    complete: 'POST /caretaker/{token}/tasks/{taskId}/complete',
  } as const;

  const households = async () => (await import('../../src/handlers/households/handler.js')).handler;
  const tasks = async () => (await import('../../src/handlers/tasks/handler.js')).handler;

  const view = async (token: string) =>
    call(`caretaker view ${token.slice(0, 6)}…`, await tasks(), {
      method: 'GET',
      routeKey: routes.view,
      path: `/caretaker/${token}`,
      pathParameters: { token },
    });

  async function createSeat() {
    const res = await create(await households(), {
      method: 'POST',
      routeKey: routes.create,
      path: `/households/${householdId}/caretakers`,
      pathParameters: { id: householdId },
      identity: admin,
      body: { name: 'Dana', expiresAt: future(10) },
    });
    expect(res.statusCode).toBe(201);
    return res.body as { token: string; url: string; id: string };
  }

  it('creation stores only a digest, and the token appears nowhere after the creation response', async () => {
    const seat = await createSeat();
    expect(seat.token).toMatch(HEX64);
    assertHashedOnlyAtRest(seat.token, 'caretakerSeat', 'CARETAKER#');

    const list = await call('list caretakers', await households(), {
      method: 'GET',
      routeKey: routes.list,
      path: `/households/${householdId}/caretakers`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(list.statusCode).toBe(200);
    expect((await view(seat.token)).statusCode).toBe(200);
    const done = await call('complete via caretaker', await tasks(), {
      method: 'POST',
      routeKey: routes.complete,
      path: `/caretaker/${seat.token}/tasks/${taskId}/complete`,
      pathParameters: { token: seat.token, taskId },
      body: {},
    });
    expect(done.statusCode).toBe(200);
    const revoked = await call('revoke caretaker', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/caretakers/${seat.id}`,
      pathParameters: { id: householdId, caretakerId: seat.id },
      identity: admin,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await view(seat.token)).statusCode).toBe(404);

    assertLoggingWasOn('/caretaker/{token}', 'household.member_added');
    assertHashedOnlyAtRest(seat.token, 'caretakerSeat', 'CARETAKER#');
    assertNeverLeaked(seat.token);
  });

  it('unknown, revoked, malformed and digest tokens all answer the same', async () => {
    const revokedSeat = await createSeat();
    await call('revoke', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/caretakers/${revokedSeat.id}`,
      pathParameters: { id: householdId, caretakerId: revokedSeat.id },
      identity: admin,
    });
    const live = await createSeat();
    const digest = hashCapabilityToken('caretakerSeat', live.token);

    const unknown = await view(hex64('ab12'));
    expect(unknown.statusCode).toBe(404);
    for (const token of [revokedSeat.token, 'short', digest]) {
      expect(failureOf(await view(token))).toEqual(failureOf(unknown));
    }
    expect((await view(live.token)).statusCode).toBe(200);
  });

  it('a seat handed out before hashing still works, and its first use moves it', async () => {
    const token = hex64('5ea7');
    store.put({
      PK: `CARETAKER#${token}`,
      SK: 'METADATA',
      GSI1PK: `HOUSEHOLD#${householdId}#CARETAKER`,
      GSI1SK: past(2),
      entityType: 'Caretaker',
      id: 'legacy-seat-1',
      token,
      householdId,
      createdBy: ADMIN.userId,
      createdAt: past(2),
      name: 'Dana',
      startsAt: past(2),
      expiresAt: future(8),
      status: 'active',
      ttl: 9_999_999_999,
    });
    const rowsBefore = store.all().length;

    const listed = await call('list caretakers', await households(), {
      method: 'GET',
      routeKey: routes.list,
      path: `/households/${householdId}/caretakers`,
      pathParameters: { id: householdId },
      identity: admin,
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.body)).toContain('legacy-seat-1');
    assertNeverLeaked(token);

    const first = await view(token);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ caretakerName: 'Dana' });
    expect(store.all().length).toBe(rowsBefore);
    assertHashedOnlyAtRest(token, 'caretakerSeat', 'CARETAKER#');

    const revoked = await call('revoke moved seat', await households(), {
      method: 'DELETE',
      routeKey: routes.revoke,
      path: `/households/${householdId}/caretakers/legacy-seat-1`,
      pathParameters: { id: householdId, caretakerId: 'legacy-seat-1' },
      identity: admin,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await view(token)).statusCode).toBe(404);
    assertNeverLeaked(token);
  });
});

// ---------------------------------------------------------------------------
// Cutting shares — the path parameter is `code`, not `token`
// ---------------------------------------------------------------------------

describe('cutting shares', () => {
  const routes = {
    share: 'POST /plants/{id}/share',
    view: 'GET /plants/shared/{code}',
  } as const;

  const plants = async () => (await import('../../src/handlers/plants/handler.js')).handler;

  const view = async (code: string) =>
    call(`shared view ${code.slice(0, 6)}…`, await plants(), {
      method: 'GET',
      routeKey: routes.view,
      path: `/plants/shared/${code}`,
      pathParameters: { code },
    });

  async function share() {
    const res = await create(await plants(), {
      method: 'POST',
      routeKey: routes.share,
      path: `/plants/${plantId}/share`,
      pathParameters: { id: plantId },
      identity: admin,
    });
    expect(res.statusCode).toBe(201);
    return res.body as { code: string };
  }

  it('creation stores only a digest, and the code appears nowhere after the creation response', async () => {
    const created = await share();
    expect(created.code).toMatch(HEX32);
    assertHashedOnlyAtRest(created.code, 'plantShare', 'SHARE#');

    const seen = await view(created.code);
    expect(seen.statusCode).toBe(200);
    expect(seen.body).toMatchObject({ plant: { name: 'Monstera' } });

    // The request log is where this one used to leak: `/plants/shared/{code}`
    // binds its secret to a parameter called `code`, and only `token` was scrubbed.
    assertLoggingWasOn('/plants/shared/{code}');
    assertNeverLeaked(created.code);
  });

  it('unknown, malformed, expired and digest codes all answer the same', async () => {
    const live = await share();
    const digest = hashCapabilityToken('plantShare', live.code);
    const expiredCode = 'e0e0e0e0'.repeat(4);
    store.put({
      PK: `SHARE#${hashCapabilityToken('plantShare', expiredCode)}`,
      SK: 'METADATA',
      entityType: 'PlantShare',
      codeHash: hashCapabilityToken('plantShare', expiredCode),
      plantId,
      householdId,
      plantSnapshot: { name: 'Monstera', species: null, careRule: null, imageUrl: null, tags: [] },
      createdBy: ADMIN.userId,
      createdAt: past(20),
      expiresAt: past(1),
    });

    const unknown = await view('ab12ab12'.repeat(4));
    expect(unknown.statusCode).toBe(404);
    for (const code of ['short', digest, expiredCode]) {
      expect(failureOf(await view(code))).toEqual(failureOf(unknown));
    }
    expect((await view(live.code)).statusCode).toBe(200);
  });

  it('a share link sent before hashing still opens, and its first view moves it', async () => {
    const code = '5a4e5a4e'.repeat(4);
    store.put({
      PK: `SHARE#${code}`,
      SK: 'METADATA',
      entityType: 'PlantShare',
      code,
      plantId,
      householdId,
      plantSnapshot: { name: 'Monstera', species: null, careRule: null, imageUrl: null, tags: [] },
      createdBy: ADMIN.userId,
      createdAt: past(1),
      expiresAt: future(13),
      ttl: 9_999_999_999,
    });
    const rowsBefore = store.all().length;

    const first = await view(code);
    expect(first.statusCode).toBe(200);
    expect(store.all().length).toBe(rowsBefore);
    assertHashedOnlyAtRest(code, 'plantShare', 'SHARE#');
    assertNeverLeaked(code);
  });
});

// ---------------------------------------------------------------------------
// Calendar feeds — hashed since before #450, and held to the same four checks
// ---------------------------------------------------------------------------

describe('calendar feeds', () => {
  it('the token is in the creation response only, and the feed route logs a placeholder', async () => {
    const me = (await import('../../src/handlers/me/handler.js')).handler;
    const created = await create(me, {
      method: 'POST',
      routeKey: 'POST /me/calendar-token',
      path: '/me/calendar-token',
      identity: admin,
    });
    expect(created.statusCode).toBe(201);
    const { token } = created.body as { token: string };
    expect(token).toMatch(HEX64);
    assertHashedOnlyAtRest(token, 'calendarToken', 'CALTOKEN_HASH#', 'GSI1PK');

    const status = await call('calendar status', me, {
      method: 'GET',
      routeKey: 'GET /me/calendar-token',
      path: '/me/calendar-token',
      identity: admin,
    });
    expect(status.statusCode).toBe(200);
    const feed = await call('calendar feed', me, {
      method: 'GET',
      routeKey: 'GET /calendar/{token}/family-greenhouse.ics',
      path: `/calendar/${token}/family-greenhouse.ics`,
      pathParameters: { token },
    });
    expect(feed.statusCode).toBe(200);

    assertLoggingWasOn('/calendar/{token}/family-greenhouse.ics', 'calendar_token.created');
    assertNeverLeaked(token);
  });
});

// ---------------------------------------------------------------------------
// The assertions themselves can fail
// ---------------------------------------------------------------------------

describe('negative controls: the checks above are not vacuous', () => {
  it('an at-rest check fails on a table that stores the token in plaintext', () => {
    const token = hex64('dead');
    // What the code did before #450 — and would do again if hashing were reverted.
    store.put({ PK: `PLANTTAG#${token}`, SK: 'METADATA', token, householdId, plantId });
    expect(() => assertHashedOnlyAtRest(token, 'plantTag', 'PLANTTAG#')).toThrow(
      /stored in the table in plaintext/
    );
  });

  it('an at-rest check fails on a table that has no row under the digest at all', () => {
    expect(() => assertHashedOnlyAtRest(hex64('beef'), 'plantTag', 'PLANTTAG#')).toThrow(
      /no row is stored under the token's digest/
    );
  });

  it('a leak check fails on a token in a response body, in a header, and in a log line', () => {
    const token = hex64('cafe');
    observed.push({
      label: 'body',
      res: { statusCode: 200, body: { echoed: token }, headers: {} },
    });
    expect(() => assertNeverLeaked(token)).toThrow(/in the response to: body/);
    observed.length = 0;

    observed.push({
      label: 'header',
      res: { statusCode: 200, body: {}, headers: { location: `/tag/${token}` } },
    });
    expect(() => assertNeverLeaked(token)).toThrow(/in the response to: header/);
    observed.length = 0;

    expect(() => assertNeverLeaked(token)).not.toThrow();
    logged.lines.push(`{"msg":"request","path":"/tag/${token}"}\n`);
    expect(() => assertNeverLeaked(token)).toThrow(/in a log line/);
  });

  it('the request log really does scrub: the SAME request logged without the scrub would fail the check', async () => {
    // Drive a real scan, then show the check would have caught the unscrubbed
    // path the middleware would otherwise have written.
    const handler = (await import('../../src/handlers/plantTags/handler.js')).handler;
    const token = hex64('a11c');
    await call('scan', handler, {
      method: 'GET',
      routeKey: 'GET /tag/{token}',
      path: `/tag/${token}`,
      pathParameters: { token },
    });
    expect(() => assertNeverLeaked(token)).not.toThrow();
    expect(logDump()).toContain('/tag/{token}');

    logged.lines.push(`{"msg":"request","path":"/tag/${token}"}\n`); // what an unscrubbed line looks like
    expect(() => assertNeverLeaked(token)).toThrow(/in a log line/);
  });
});
