/**
 * Real-handler integration tests for how long an invite works (ADR 0047).
 *
 * An invite is a way into a household, so its life has to end: when it has
 * admitted the people it was made for, when an admin turns the household's
 * invites off, and whenever somebody leaves or is removed. The last one is
 * the case that matters most. Removing a person is sometimes done for that
 * person's absence to mean something, and a link they still hold must not
 * undo it.
 *
 * These run the REAL households handlers through the REAL middy chain against
 * the REAL services on the in-memory single table, because the claim spans the
 * invite row, the household row, the join transaction and the departure
 * sequence, and no unit test sees all four.
 *
 * Both directions are asserted on purpose: an invite made AFTER the household
 * turned its invites off works, and a pending invite written before invites
 * were counted keeps working.
 *
 * Every address here is `example.invalid`; every string is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'Jo Joiner',
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  getUsersByIds: async () => new Map(),
  getUserEmail: async () => null,
}));
// The invitation email and the "someone joined" email are not what these
// tests are about; sending is reported as accepted and nothing is sent.
vi.mock('../../src/services/inviteEmail.js', () => ({
  sendInviteEmail: vi.fn(async () => 'accepted'),
  DAILY_INVITE_EMAIL_CAP: 10,
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.invalid', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.invalid', name: 'Mel Member' };
const joiner = (n: number) => ({
  userId: `user-joiner-${n}`,
  email: `joiner-${n}@example.invalid`,
  name: `Joiner ${n}`,
});

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Silence the pino request logger.
const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

/** A household on Greenhouse, so neither the member cap nor the homes cap is in play. */
async function household(members = [MEMBER]) {
  const { householdId } = await seedHousehold(store, { admin: ADMIN, members });
  await setHouseholdPlan(store, householdId, 'greenhouse');
  return householdId;
}

async function makeLink(householdId: string): Promise<string> {
  const households = await import('../../src/handlers/households/handler.js');
  const res = await invokeHandler(households.createInvite, {
    method: 'POST',
    routeKey: 'POST /households/{id}/invites',
    pathParameters: { id: householdId },
    identity: { ...ADMIN, householdId, householdRole: 'admin' },
  });
  expect(res.statusCode).toBe(201);
  return (res.body as { code: string }).code;
}

async function makeEmailedInvite(householdId: string): Promise<string> {
  const households = await import('../../src/handlers/households/handler.js');
  const res = await invokeHandler(households.emailInvite, {
    method: 'POST',
    routeKey: 'POST /households/{id}/invites/email',
    pathParameters: { id: householdId },
    identity: { ...ADMIN, householdId, householdRole: 'admin' },
    body: { email: 'friend@example.invalid' },
  });
  expect(res.statusCode).toBe(201);
  return (res.body as { code: string }).code;
}

async function join(code: string, who: { userId: string; email: string; name: string }) {
  const households = await import('../../src/handlers/households/handler.js');
  return invokeHandler(households.joinHousehold, {
    method: 'POST',
    routeKey: 'POST /households/join/{inviteCode}',
    pathParameters: { inviteCode: code },
    identity: who,
  });
}

async function looksValid(code: string): Promise<boolean> {
  const households = await import('../../src/handlers/households/handler.js');
  const res = await invokeHandler(households.validateInvite, {
    method: 'GET',
    routeKey: 'GET /households/invites/{inviteCode}',
    pathParameters: { inviteCode: code },
  });
  expect(res.statusCode).toBe(200);
  return (res.body as { valid: boolean }).valid;
}

async function isMember(householdId: string, userId: string): Promise<boolean> {
  const householdService = await import('../../src/services/householdService.js');
  return (await householdService.getMemberByUserId(householdId, userId)) !== null;
}

describe('an invite stops working when a member is removed', () => {
  it('a removed member cannot rejoin with the link they joined with, or with any other link made before', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const householdId = await household([]);
    const joinedWith = await makeLink(householdId);
    const another = await makeLink(householdId);
    const person = joiner(1);

    expect((await join(joinedWith, person)).statusCode).toBe(200);
    expect(await isMember(householdId, person.userId)).toBe(true);
    // The link has uses left, and the other one is untouched.
    expect(await looksValid(joinedWith)).toBe(true);
    expect(await looksValid(another)).toBe(true);

    const removal = await invokeHandler(households.removeMember, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{householdId}/members/{userId}',
      pathParameters: { householdId, userId: person.userId },
      identity: { ...ADMIN, householdId, householdRole: 'admin' },
    });
    expect(removal.statusCode).toBe(204);
    expect(await isMember(householdId, person.userId)).toBe(false);

    for (const code of [joinedWith, another]) {
      expect(await looksValid(code)).toBe(false);
      const back = await join(code, person);
      expect(back.statusCode).toBe(400);
      expect((back.body as { message: string }).message).toBe('Invalid or expired invite');
    }
    expect(await isMember(householdId, person.userId)).toBe(false);
  });

  it('an invite the admin makes after the removal works', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const householdId = await household();
    await invokeHandler(households.removeMember, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{householdId}/members/{userId}',
      pathParameters: { householdId, userId: MEMBER.userId },
      identity: { ...ADMIN, householdId, householdRole: 'admin' },
    });
    // Invite timestamps are compared to the millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const fresh = await makeLink(householdId);
    expect(await looksValid(fresh)).toBe(true);
    expect((await join(fresh, joiner(2))).statusCode).toBe(200);
  });

  it('a member who leaves cannot come back with an old link either', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const householdId = await household([]);
    const link = await makeLink(householdId);
    const person = joiner(3);
    expect((await join(link, person)).statusCode).toBe(200);

    const left = await invokeHandler(households.leaveHousehold, {
      method: 'POST',
      routeKey: 'POST /households/{id}/leave',
      pathParameters: { id: householdId },
      identity: { ...person, householdId },
      body: {},
    });
    expect(left.statusCode).toBe(200);

    expect(await looksValid(link)).toBe(false);
    expect((await join(link, person)).statusCode).toBe(400);
    expect(await isMember(householdId, person.userId)).toBe(false);
  });
});

describe('an admin can turn the household invites off', () => {
  it('every invite made so far stops working, and a new one works', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const householdId = await household();
    const link = await makeLink(householdId);
    const emailed = await makeEmailedInvite(householdId);
    expect(await looksValid(link)).toBe(true);
    expect(await looksValid(emailed)).toBe(true);

    const revoked = await invokeHandler(households.revokeInvites, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{id}/invites',
      pathParameters: { id: householdId },
      identity: { ...ADMIN, householdId, householdRole: 'admin' },
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.body as { revokedAt: string }).revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    for (const code of [link, emailed]) {
      expect(await looksValid(code)).toBe(false);
      expect((await join(code, joiner(4))).statusCode).toBe(400);
    }
    expect(await isMember(householdId, joiner(4).userId)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await makeLink(householdId);
    expect((await join(fresh, joiner(4))).statusCode).toBe(200);
  });

  it('is refused for a member who is not an admin, and changes nothing', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const householdId = await household();
    const link = await makeLink(householdId);
    const refused = await invokeHandler(households.revokeInvites, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{id}/invites',
      pathParameters: { id: householdId },
      identity: { ...MEMBER, householdId, householdRole: 'member' },
    });
    expect(refused.statusCode).toBe(403);
    expect(await looksValid(link)).toBe(true);
  });
});

describe('an invite admits a limited number of people', () => {
  it('a link admits five people and refuses the sixth', async () => {
    const householdId = await household();
    const link = await makeLink(householdId);
    for (let n = 1; n <= 5; n += 1) {
      expect((await join(link, joiner(n))).statusCode, `joiner ${n}`).toBe(200);
    }
    expect(await looksValid(link)).toBe(false);
    const sixth = await join(link, joiner(6));
    expect(sixth.statusCode).toBe(400);
    expect((sixth.body as { message: string }).message).toBe('Invalid or expired invite');
    expect(await isMember(householdId, joiner(6).userId)).toBe(false);
  });

  it('an emailed invite admits one person and refuses the second', async () => {
    const householdId = await household();
    const emailed = await makeEmailedInvite(householdId);
    expect((await join(emailed, joiner(1))).statusCode).toBe(200);
    expect(await looksValid(emailed)).toBe(false);
    expect((await join(emailed, joiner(2))).statusCode).toBe(400);
    expect(await isMember(householdId, joiner(2).userId)).toBe(false);
  });

  it('a join that the plan refuses does not use the invite up', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    // Seedling: two people, and the household already has two.
    await setHouseholdPlan(store, householdId, 'seedling');
    const emailed = await makeEmailedInvite(householdId);
    const refused = await join(emailed, joiner(1));
    expect(refused.statusCode).toBe(402);
    // The one use is still there for when there is room.
    expect(await looksValid(emailed)).toBe(true);
    await setHouseholdPlan(store, householdId, 'greenhouse');
    expect((await join(emailed, joiner(1))).statusCode).toBe(200);
  });

  it('someone who is already a member does not use the invite up', async () => {
    const householdId = await household();
    const emailed = await makeEmailedInvite(householdId);
    const again = await join(emailed, { ...MEMBER, householdId } as typeof MEMBER);
    expect(again.statusCode).toBe(400);
    expect(await looksValid(emailed)).toBe(true);
  });
});

describe('an invite that was pending before invites were counted', () => {
  it('keeps working: it reads as a link with every use left', async () => {
    const householdId = await household();
    const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    // Exactly the row the previous release wrote: no maxUses, no uses.
    store.put({
      PK: 'INVITE#legacy0000000000000000000000000a',
      SK: 'METADATA',
      entityType: 'HouseholdInvite',
      code: 'legacy0000000000000000000000000a',
      householdId,
      createdBy: ADMIN.userId,
      createdAt,
      expiresAt,
      ttl: Math.floor(new Date(expiresAt).getTime() / 1000),
    });
    const code = 'legacy0000000000000000000000000a';
    expect(await looksValid(code)).toBe(true);
    expect((await join(code, joiner(1))).statusCode).toBe(200);
    expect((await join(code, joiner(2))).statusCode).toBe(200);
    // And it is counted from here on.
    const row = store.all().find((i) => i.PK === `INVITE#${code}`);
    expect(row?.uses).toBe(2);
  });
});
