/**
 * Real-handler integration tests for the calendar-feed link — the
 * capability URL behind the subscribe-able `.ics` feed.
 *
 * Runs the REAL `me` handlers through the REAL middy chain against the REAL
 * calendarTokens / taskService / householdService services on the in-memory
 * single-table DynamoDB (see ./README.md). Covers what unit tests can't
 * prove end to end:
 *
 *   - the original bug: `GET /me/calendar.ics` 401s a session-less fetch;
 *   - mint → anonymous fetch → the feed carries titles + due dates and NOT
 *     the task's notes or assignee name;
 *   - a token is bound to ONE (user, household): A's feed never contains B's
 *     tasks, in either direction;
 *   - missing / malformed / unknown / revoked → 404, regenerate kills the old
 *     URL and the new one works, and a member removed from the household
 *     loses the feed even though their token row still exists;
 *   - the hash-at-rest guarantee: no stored row contains the plaintext.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, seedPlant } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.com', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.com', name: 'Mel Member' };
const B_ADMIN = { userId: 'user-b', email: 'b@example.com', name: 'Bea Bee' };

const FEED_ROUTE = 'GET /calendar/{token}/family-greenhouse.ics';

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
});

// Silence the pino request logger.
const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});

async function seedTask(
  householdId: string,
  plantName: string,
  input: { notes?: string; assignedTo?: string }
) {
  const taskService = await import('../../src/services/taskService.js');
  const plant = await seedPlant(store, householdId, ADMIN.userId, { name: plantName });
  return taskService.createTask(
    { plantId: plant.id, type: 'water', frequency: 7, ...input },
    householdId,
    ADMIN.userId,
    plantName
  );
}

/** Mint a link as `identity` for the household in their claim. Returns the token. */
async function mint(identity: { userId: string; email: string; householdId: string }) {
  const me = await import('../../src/handlers/me/handler.js');
  const res = await invokeHandler(me.createCalendarToken, {
    method: 'POST',
    routeKey: 'POST /me/calendar-token',
    identity,
  });
  expect(res.statusCode).toBe(201);
  const body = res.body as { token: string; path: string; active: boolean };
  expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  expect(body.path).toBe(`/calendar/${body.token}/family-greenhouse.ics`);
  return body.token;
}

/** Anonymous feed fetch — exactly what a calendar app sends: no headers, no session. */
async function fetchFeed(token: string) {
  const me = await import('../../src/handlers/me/handler.js');
  return invokeHandler(me.calendarFeed, {
    method: 'GET',
    routeKey: FEED_ROUTE,
    path: `/calendar/${token}/family-greenhouse.ics`,
    pathParameters: { token },
  });
}

describe('calendar feed: the original bug', () => {
  it('GET /me/calendar.ics rejects a session-less fetch with 401 (so it can never be a subscription URL)', async () => {
    const me = await import('../../src/handlers/me/handler.js');
    const res = await invokeHandler(me.calendarIcs, {
      method: 'GET',
      routeKey: 'GET /me/calendar.ics',
      // no identity — what Apple/Google/Outlook send
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ message: 'Unauthorized' });
  });
});

describe('calendar feed: mint → anonymous fetch', () => {
  it("serves titles + due dates for the token holder's household, and nothing a leaked link should reveal", async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    await seedTask(householdId, 'Monstera', {
      notes: 'spare key under the blue pot',
      assignedTo: MEMBER.userId,
    });

    const token = await mint({ ...MEMBER, householdId });
    const res = await fetchFeed(token);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/calendar/);
    const ics = res.body as string;
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toMatch(/SUMMARY:Water — Monstera/);
    expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
    // Trimmed on purpose — see services/icsExport.ts.
    expect(ics).not.toContain('spare key');
    expect(ics).not.toContain('Mel Member');
    expect(ics).not.toContain(MEMBER.userId);
    expect(ics).not.toContain(MEMBER.email);
  });

  it('stores only a hash: no row in the table contains the plaintext token', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const token = await mint({ ...ADMIN, householdId });
    const dump = JSON.stringify(store.all());
    expect(dump).not.toContain(token);
    expect(dump).toContain('CALTOKEN_HASH#');
    // …and the row lives in the user's partition (swept with the account).
    expect(
      store.all().some((i) => i.PK === `USER#${ADMIN.userId}` && i.SK === `CALTOKEN#${householdId}`)
    ).toBe(true);
  });

  it('records lastUsedAt on a successful fetch, visible from the status route (never the token)', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const token = await mint({ ...ADMIN, householdId });
    const me = await import('../../src/handlers/me/handler.js');

    const before = await invokeHandler(me.getCalendarToken, {
      method: 'GET',
      routeKey: 'GET /me/calendar-token',
      identity: { ...ADMIN, householdId },
    });
    expect(before.body).toEqual({ active: true, createdAt: expect.any(String), lastUsedAt: null });

    expect((await fetchFeed(token)).statusCode).toBe(200);

    const after = await invokeHandler(me.getCalendarToken, {
      method: 'GET',
      routeKey: 'GET /me/calendar-token',
      identity: { ...ADMIN, householdId },
    });
    expect((after.body as { lastUsedAt: string | null }).lastUsedAt).toEqual(expect.any(String));
    expect(JSON.stringify(after.body)).not.toContain(token);
  });
});

describe('calendar feed: scope is one user, one household', () => {
  it('a token for household A never reads household B, in either direction', async () => {
    const a = await seedHousehold(store, { name: 'House A', admin: ADMIN });
    const b = await seedHousehold(store, { name: 'House B', admin: B_ADMIN });
    await seedTask(a.householdId, 'Monstera', {});
    // B's plant is created by ADMIN's id purely as the `createdBy` attribution
    // (seedTask reuses ADMIN); membership is what scopes the feed, and ADMIN
    // is NOT a member of B.
    await seedTask(b.householdId, 'Fiddle Leaf Fig', {});

    const tokenA = await mint({ ...ADMIN, householdId: a.householdId });
    const tokenB = await mint({ ...B_ADMIN, householdId: b.householdId });

    const feedA = (await fetchFeed(tokenA)).body as string;
    const feedB = (await fetchFeed(tokenB)).body as string;

    expect(feedA).toContain('Monstera');
    expect(feedA).not.toContain('Fiddle Leaf Fig');
    expect(feedB).toContain('Fiddle Leaf Fig');
    expect(feedB).not.toContain('Monstera');
  });

  it('a member removed from the household loses the feed even though their token row still exists', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    await seedTask(householdId, 'Monstera', {});
    const token = await mint({ ...MEMBER, householdId });
    expect((await fetchFeed(token)).statusCode).toBe(200);

    const householdService = await import('../../src/services/householdService.js');
    await householdService.removeMember(householdId, MEMBER.userId);

    const res = await fetchFeed(token);
    expect(res.statusCode).toBe(404);
    // The row is still there — membership, not the row, is what gates the feed.
    expect(
      store.all().some((i) => i.SK === `CALTOKEN#${householdId}` && i.userId === MEMBER.userId)
    ).toBe(true);
  });

  it("tokens are per household: regenerating for A leaves the same user's B link intact", async () => {
    const a = await seedHousehold(store, { name: 'House A', admin: ADMIN });
    const b = await seedHousehold(store, { name: 'House B', admin: B_ADMIN, members: [ADMIN] });
    const tokenA = await mint({ ...ADMIN, householdId: a.householdId });
    const tokenB = await mint({ ...ADMIN, householdId: b.householdId });

    const tokenA2 = await mint({ ...ADMIN, householdId: a.householdId }); // regenerate A

    expect((await fetchFeed(tokenA)).statusCode).toBe(404);
    expect((await fetchFeed(tokenA2)).statusCode).toBe(200);
    expect((await fetchFeed(tokenB)).statusCode).toBe(200);
  });
});

describe('calendar feed: missing / invalid / revoked / regenerated', () => {
  it('404s an unknown well-formed token, a malformed one, and an empty one — same message', async () => {
    await seedHousehold(store, { admin: ADMIN });
    for (const token of ['9'.repeat(64), 'not-a-token', '']) {
      const res = await fetchFeed(token);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ message: 'This calendar link is invalid or has been revoked.' });
    }
  });

  it('revoke kills the URL immediately; a second revoke is a 404', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const token = await mint({ ...ADMIN, householdId });
    expect((await fetchFeed(token)).statusCode).toBe(200);

    const me = await import('../../src/handlers/me/handler.js');
    const revoke = () =>
      invokeHandler(me.revokeCalendarToken, {
        method: 'DELETE',
        routeKey: 'DELETE /me/calendar-token',
        identity: { ...ADMIN, householdId },
      });
    expect((await revoke()).statusCode).toBe(204);
    expect((await fetchFeed(token)).statusCode).toBe(404);
    expect((await revoke()).statusCode).toBe(404);

    const status = await invokeHandler(me.getCalendarToken, {
      method: 'GET',
      routeKey: 'GET /me/calendar-token',
      identity: { ...ADMIN, householdId },
    });
    expect(status.body).toEqual({ active: false, createdAt: null, lastUsedAt: null });
  });

  it('regenerate invalidates the old URL and the new one works', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const first = await mint({ ...ADMIN, householdId });
    expect((await fetchFeed(first)).statusCode).toBe(200);

    const second = await mint({ ...ADMIN, householdId });
    expect(second).not.toBe(first);
    expect((await fetchFeed(first)).statusCode).toBe(404);
    expect((await fetchFeed(second)).statusCode).toBe(200);
  });

  it('management routes are authed: an anonymous caller can neither mint nor read status', async () => {
    const me = await import('../../src/handlers/me/handler.js');
    const mintAnon = await invokeHandler(me.createCalendarToken, {
      method: 'POST',
      routeKey: 'POST /me/calendar-token',
    });
    expect(mintAnon.statusCode).toBe(401);
    const statusAnon = await invokeHandler(me.getCalendarToken, {
      method: 'GET',
      routeKey: 'GET /me/calendar-token',
    });
    expect(statusAnon.statusCode).toBe(401);
  });
});

void originalLog;
