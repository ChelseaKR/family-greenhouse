/**
 * Real-handler integration tests for what a departure costs a household's
 * PUBLIC cutting links.
 *
 * Removing a member revokes the capability tokens they minted (#449) — plant
 * tags, sitter links, kiosk links. Cutting shares were missed by that sweep,
 * and they are the one credential in the family that needs no credential at
 * all: `GET /plants/shared/{code}` is an unauthenticated route whose link is
 * pasted into group chats. A link minted on the way out kept serving the
 * household's plant card for the rest of its 14-day life.
 *
 * These run the REAL households / plants handlers through the REAL middy
 * chain against the REAL services on the in-memory single table, because the
 * claim under test spans three of them (the share row, the removal sweep, and
 * the public read) and no unit test sees all three.
 *
 * Both directions are asserted on purpose. A sweep that deleted every share
 * in the household would pass the first assertion and be a different bug, so
 * the share minted by the member who STAYED must still resolve afterwards.
 *
 * Every address here is `example.invalid`; every string is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, seedPlant } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
// Removal rewrites the departing user's Cognito claims; the pool itself is
// not what these tests are about.
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async () => 'Mel Member',
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  getUsersByIds: async () => new Map(),
  getUserEmail: async () => null,
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.invalid', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.invalid', name: 'Mel Member' };

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
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
afterEach(() => {
  console.log = originalLog;
});

/** Mint a cutting link for a fresh plant, as `identity`, and return its code. */
async function mintShare(
  householdId: string,
  identity: { userId: string; email: string },
  plantName: string
): Promise<string> {
  const plantsHandler = await import('../../src/handlers/plants/handler.js');
  const plant = await seedPlant(store, householdId, identity.userId, { name: plantName });
  const res = await invokeHandler(plantsHandler.sharePlant, {
    method: 'POST',
    routeKey: 'POST /plants/{id}/share',
    pathParameters: { id: plant.id },
    identity: { ...identity, householdId },
  });
  expect(res.statusCode).toBe(201);
  return (res.body as { code: string }).code;
}

/** The public preview, with NO credential but the code in the path. */
async function previewStatus(code: string): Promise<number> {
  const plantsHandler = await import('../../src/handlers/plants/handler.js');
  const res = await invokeHandler(plantsHandler.getSharedPlant, {
    method: 'GET',
    routeKey: 'GET /plants/shared/{code}',
    pathParameters: { code },
  });
  return res.statusCode;
}

describe('cutting shares and departure', () => {
  it('stops resolving the links a removed member minted, and keeps the rest', async () => {
    const householdsHandler = await import('../../src/handlers/households/handler.js');
    const { householdId } = await seedHousehold(store, {
      admin: ADMIN,
      members: [MEMBER],
    });

    const theirs = await mintShare(householdId, MEMBER, 'PLANTNAME-MU');
    const staying = await mintShare(householdId, ADMIN, 'PLANTNAME-NU');

    // Both links are live before the removal.
    expect(await previewStatus(theirs)).toBe(200);
    expect(await previewStatus(staying)).toBe(200);

    const removal = await invokeHandler(householdsHandler.removeMember, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{householdId}/members/{userId}',
      pathParameters: { householdId, userId: MEMBER.userId },
      identity: { ...ADMIN, householdId, householdRole: 'admin' },
    });
    expect(removal.statusCode).toBe(204);

    // The departing member's public link is gone...
    expect(await previewStatus(theirs)).toBe(404);
    // ...and the household did not lose the link it still owns.
    expect(await previewStatus(staying)).toBe(200);
  });

  it('erases a household’s cutting links when its last member deletes the account', async () => {
    const accountCleanup = await import('../../src/services/accountCleanup.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const code = await mintShare(householdId, ADMIN, 'PLANTNAME-XI');
    expect(await previewStatus(code)).toBe(200);

    // The sweep account deletion runs for a household nobody is left in.
    await accountCleanup.deleteAbandonedHouseholdData(householdId);

    expect(await previewStatus(code)).toBe(404);
  });
});
