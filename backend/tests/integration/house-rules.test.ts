/**
 * House rule (`careRule`) round-trip through the REAL plants handlers and the
 * REAL middy chain (auth → validation → service), DynamoDB faked at the SDK
 * boundary. Proves the field is set by an ordinary member (not admin-only,
 * not plan-gated), trimmed and capped server-side, carried on every plant
 * read, and cleared — never stored blank — when emptied.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.com', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.com', name: 'Mel Member' };

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

// Silence the pino request logger.
beforeEach(() => {
  console.log = () => {};
});

type PlantBody = { id: string; careRule: string | null };

describe('real-handler: house rule (careRule) round-trip', () => {
  it('any member can set, read back, and clear a rule; blanks never persist as rules', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });

    // Created without a rule → null on the response, never undefined.
    const created = await invokeHandler(plantsHandler.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity: { ...ADMIN, householdId },
      body: { name: 'Calathea' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toHaveProperty('careRule', null);
    const plantId = (created.body as PlantBody).id;

    // A plain MEMBER sets it — the field is neither admin-only nor paid.
    // Padded input is trimmed before it is stored.
    const updated = await invokeHandler(plantsHandler.updatePlant, {
      method: 'PUT',
      routeKey: 'PUT /plants/{id}',
      pathParameters: { id: plantId },
      identity: { ...MEMBER, householdId },
      body: { careRule: '  Bottom-water only  ' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toMatchObject({ careRule: 'Bottom-water only' });

    // Every plant read carries it: the single-plant composite and the list.
    const read = await invokeHandler(plantsHandler.getPlant, {
      method: 'GET',
      routeKey: 'GET /plants/{id}',
      pathParameters: { id: plantId },
      identity: { ...MEMBER, householdId },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ careRule: 'Bottom-water only' });

    const list = await invokeHandler(plantsHandler.listPlants, {
      method: 'GET',
      routeKey: 'GET /plants',
      identity: { ...MEMBER, householdId },
    });
    expect(list.statusCode).toBe(200);
    expect((list.body as PlantBody[]).find((p) => p.id === plantId)?.careRule).toBe(
      'Bottom-water only'
    );

    // Emptying the field clears the rule: stored as null, not "" or "   ".
    const cleared = await invokeHandler(plantsHandler.updatePlant, {
      method: 'PUT',
      routeKey: 'PUT /plants/{id}',
      pathParameters: { id: plantId },
      identity: { ...MEMBER, householdId },
      body: { careRule: '   ' },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).toHaveProperty('careRule', null);

    const reread = await invokeHandler(plantsHandler.getPlant, {
      method: 'GET',
      routeKey: 'GET /plants/{id}',
      pathParameters: { id: plantId },
      identity: { ...MEMBER, householdId },
    });
    expect(reread.body).toHaveProperty('careRule', null);
  });

  it('rejects a rule over 140 characters with a real 400 and leaves the stored rule untouched', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });

    const created = await invokeHandler(plantsHandler.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity: { ...ADMIN, householdId },
      body: { name: 'Calathea', careRule: 'Bottom-water only' },
    });
    expect(created.statusCode).toBe(201);
    const plantId = (created.body as PlantBody).id;

    const rejected = await invokeHandler(plantsHandler.updatePlant, {
      method: 'PUT',
      routeKey: 'PUT /plants/{id}',
      pathParameters: { id: plantId },
      identity: { ...ADMIN, householdId },
      body: { careRule: 'x'.repeat(141) },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toMatchObject({ message: 'Validation failed' });
    expect((rejected.body as { details: Record<string, unknown> }).details).toHaveProperty(
      'careRule'
    );

    const read = await invokeHandler(plantsHandler.getPlant, {
      method: 'GET',
      routeKey: 'GET /plants/{id}',
      pathParameters: { id: plantId },
      identity: { ...ADMIN, householdId },
    });
    expect(read.body).toMatchObject({ careRule: 'Bottom-water only' });
  });

  it('accepts a rule of exactly 140 characters at create time, trimmed', async () => {
    const plantsHandler = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const rule = 'x'.repeat(140);

    const created = await invokeHandler(plantsHandler.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity: { ...ADMIN, householdId },
      body: { name: 'Calathea', careRule: `  ${rule} ` },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ careRule: rule });
  });
});
