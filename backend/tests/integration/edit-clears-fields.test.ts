/**
 * Null clears a plant's notes and species and a task's notes and custom name,
 * through the real handlers. The edit forms send null for an emptied field and
 * rely on this; an omitted key must still leave the value alone.
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

beforeEach(async () => {
  store.reset();
  console.log = () => {};
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

describe('clearing optional fields with null', () => {
  it('clears a plant’s notes and species, and an omitted key leaves them alone', async () => {
    const plants = await import('../../src/handlers/plants/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const identity = { ...ADMIN, householdId };
    const created = await invokeHandler(plants.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity,
      body: { name: 'Fern', species: 'Nephrolepis', notes: 'Gate code is 4412' },
    });
    const id = (created.body as { id: string }).id;
    const put = (body: Record<string, unknown>) =>
      invokeHandler(plants.updatePlant, {
        method: 'PUT',
        routeKey: 'PUT /plants/{id}',
        pathParameters: { id },
        identity,
        body,
      });

    const untouched = await put({ name: 'Fern' });
    expect(untouched.body).toMatchObject({ species: 'Nephrolepis', notes: 'Gate code is 4412' });

    const cleared = await put({ species: null, notes: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).toMatchObject({ species: null, notes: null, speciesSource: null });
  });

  it('clears a task’s notes and custom name', async () => {
    const plants = await import('../../src/handlers/plants/handler.js');
    const tasks = await import('../../src/handlers/tasks/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    const identity = { ...ADMIN, householdId };
    const plant = await invokeHandler(plants.createPlant, {
      method: 'POST',
      routeKey: 'POST /plants',
      identity,
      body: { name: 'Fern' },
    });
    const created = await invokeHandler(tasks.createTask, {
      method: 'POST',
      routeKey: 'POST /tasks',
      identity,
      body: {
        plantId: (plant.body as { id: string }).id,
        type: 'custom',
        customType: 'Mist',
        frequency: 7,
        notes: 'Use rainwater',
      },
    });
    expect(created.body).toMatchObject({ customType: 'Mist', notes: 'Use rainwater' });

    const cleared = await invokeHandler(tasks.updateTask, {
      method: 'PUT',
      routeKey: 'PUT /tasks/{id}',
      pathParameters: { id: (created.body as { id: string }).id },
      identity,
      body: { type: 'water', customType: null, notes: null },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).toMatchObject({ type: 'water', customType: null, notes: null });
  });
});
