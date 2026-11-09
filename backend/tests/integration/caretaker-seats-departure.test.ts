/**
 * Real-handler integration tests: a caretaker seat ends when the member who
 * created it leaves or is removed, the same as that member's sitter links.
 *
 * A seat URL is shown once, to the admin who created it, and opens the
 * household's tasks and spaces for up to 180 days. Without this, a removed
 * admin who kept the URL could go on reading and completing tasks.
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
  getUserName: async (_id: string, email: string) => email.split('@')[0],
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  deleteUser: async () => undefined,
}));
vi.mock('../../src/services/householdEmails.js', async (orig) => ({
  ...(await orig<typeof import('../../src/services/householdEmails.js')>()),
  notifyMemberLeft: async () => undefined,
  sendLeaveConfirmation: async () => undefined,
}));

const STAYING = { userId: 'user-staying', email: 'staying@example.invalid', name: 'Sam Staying' };
const DEPARTING = { userId: 'user-going', email: 'going@example.invalid', name: 'Gia Going' };
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();

beforeEach(async () => {
  store.reset();
  vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Two admins, each of whom has created one seat. */
async function twoAdminsWithSeats() {
  const households = await import('../../src/handlers/households/handler.js');
  const management = await import('../../src/handlers/caretakers/management.js');
  const { householdId } = await seedHousehold(store, {
    admin: STAYING,
    members: [{ ...DEPARTING, role: 'admin' }],
  });
  await setHouseholdPlan(store, householdId, 'greenhouse');

  const mint = async (who: typeof STAYING, name: string) => {
    const res = await invokeHandler(management.createCaretaker, {
      method: 'POST',
      routeKey: 'POST /households/{id}/caretakers',
      pathParameters: { id: householdId },
      identity: { ...who, householdId },
      body: { name, expiresAt: inDays(30) },
    });
    expect(res.statusCode).toBe(201);
    return (res.body as { token: string }).token;
  };
  return {
    households,
    householdId,
    theirSeat: await mint(DEPARTING, 'Dana'),
    keptSeat: await mint(STAYING, 'Kit'),
  };
}

const auditDetails = (householdId: string, kind: string) =>
  store
    .all()
    .filter((row) => row.PK === `HOUSEHOLD#${householdId}#AUDIT` && row.kind === kind)
    .map((row) => row.details as Record<string, unknown>);

describe('a departure and the caretaker seats of the member who left', () => {
  it('removal ends only the removed member’s seat, keeps visits, and counts it', async () => {
    const caretakers = await import('../../src/services/caretakerService.js');
    const { households, householdId, theirSeat, keptSeat } = await twoAdminsWithSeats();

    // Both seats really work first, so "gone afterward" is not vacuous.
    const seat = await caretakers.getActiveCaretaker(theirSeat);
    expect(seat?.name).toBe('Dana');
    expect((await caretakers.getActiveCaretaker(keptSeat))?.name).toBe('Kit');
    await caretakers.recordCaretakerAction(seat!, {
      kind: 'note',
      entry: { text: 'Watered.', at: new Date().toISOString() },
    });
    expect(await caretakers.listVisits(householdId, inDays(-1), inDays(1))).toHaveLength(1);

    const removal = await invokeHandler(households.removeMember, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{householdId}/members/{userId}',
      pathParameters: { householdId, userId: DEPARTING.userId },
      identity: { ...STAYING, householdId },
    });
    expect(removal.statusCode).toBe(204);

    expect(await caretakers.getActiveCaretaker(theirSeat)).toBeNull();
    expect((await caretakers.getActiveCaretaker(keptSeat))?.name).toBe('Kit');
    // The household's record of work that happened survives the seat.
    expect(await caretakers.listVisits(householdId, inDays(-1), inDays(1))).toHaveLength(1);
    expect(auditDetails(householdId, 'member.removed')[0]).toMatchObject({ caretakerSeats: 1 });
  });

  it('leaving ends the leaver’s seat and reports it to the leaver and the audit log', async () => {
    const caretakers = await import('../../src/services/caretakerService.js');
    const { households, householdId, theirSeat, keptSeat } = await twoAdminsWithSeats();

    const left = await invokeHandler(households.leaveHousehold, {
      method: 'POST',
      routeKey: 'POST /households/{id}/leave',
      pathParameters: { id: householdId },
      identity: { ...DEPARTING, householdId },
      body: {},
    });
    expect(left.statusCode).toBe(200);
    expect(left.body).toMatchObject({ revokedCredentials: { caretakerSeats: 1 } });

    expect(await caretakers.getActiveCaretaker(theirSeat)).toBeNull();
    expect((await caretakers.getActiveCaretaker(keptSeat))?.name).toBe('Kit');
    expect(auditDetails(householdId, 'member.left')[0]).toMatchObject({ caretakerSeats: 1 });
  });
});
