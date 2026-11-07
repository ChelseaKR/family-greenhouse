/**
 * `firstPlantForAccount` on POST /plants through the REAL plants handler, the
 * REAL middy chain and the REAL milestone service, DynamoDB faked at the SDK
 * boundary. It is what gates the web app's GA4 `first_plant_added`, so it
 * must appear on exactly one create per account: not on the next plant, not
 * on a plant in a second household, and not for an account that already had
 * plants before the milestone row existed.
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

const ADA = { userId: 'user-ada', email: 'ada@example.com', name: 'Ada' };
const MEL = { userId: 'user-mel', email: 'mel@example.com', name: 'Mel' };

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
});

beforeEach(() => {
  console.log = () => {};
});

async function addPlant(
  identity: { userId: string; email: string; name: string; householdId: string },
  name: string
) {
  const plantsHandler = await import('../../src/handlers/plants/handler.js');
  const res = await invokeHandler(plantsHandler.createPlant, {
    method: 'POST',
    routeKey: 'POST /plants',
    identity,
    body: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.body as Record<string, unknown>;
}

describe('real-handler: firstPlantForAccount', () => {
  it('is on the first plant only, and never again for that account', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADA });

    const first = await addPlant({ ...ADA, householdId }, 'Pothos');
    expect(first.firstPlantForAccount).toBe(true);

    const second = await addPlant({ ...ADA, householdId }, 'Fern');
    expect(second).not.toHaveProperty('firstPlantForAccount');
    // Positive control for the negative: the second plant really was saved.
    expect(second.name).toBe('Fern');
  });

  it('is not on the first plant of the same account in a second, empty household', async () => {
    const home = await seedHousehold(store, { admin: ADA, name: 'Home' });
    expect(
      (await addPlant({ ...ADA, householdId: home.householdId }, 'Pothos')).firstPlantForAccount
    ).toBe(true);

    const cabin = await seedHousehold(store, { admin: ADA, name: 'Cabin' });
    const inCabin = await addPlant({ ...ADA, householdId: cabin.householdId }, 'Snake plant');
    expect(inCabin.name).toBe('Snake plant');
    expect(inCabin).not.toHaveProperty('firstPlantForAccount');
  });

  it('is not on any plant of an account whose household already had plants', async () => {
    // Mel joins Ada's household after Ada's first plant: Mel's first create
    // claims the row but does not count, and nothing later does either.
    const { householdId } = await seedHousehold(store, { admin: ADA, members: [MEL] });
    expect((await addPlant({ ...ADA, householdId }, 'Pothos')).firstPlantForAccount).toBe(true);

    expect(await addPlant({ ...MEL, householdId }, 'Fern')).not.toHaveProperty(
      'firstPlantForAccount'
    );
    expect(await addPlant({ ...MEL, householdId }, 'Ivy')).not.toHaveProperty(
      'firstPlantForAccount'
    );
  });

  it('stores only a timestamp in the account partition', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADA });
    await addPlant({ ...ADA, householdId }, 'Kitchen monstera');
    const { dynamodb } = await import('../../src/utils/dynamodb.js');
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const row = await dynamodb.send(
      new GetCommand({
        TableName: 'test-table',
        Key: { PK: `USER#${ADA.userId}`, SK: 'MILESTONE#FIRST_PLANT' },
      })
    );
    expect(row.Item).toEqual({
      PK: `USER#${ADA.userId}`,
      SK: 'MILESTONE#FIRST_PLANT',
      entityType: 'AccountMilestone',
      reachedAt: expect.any(String),
    });
    expect(JSON.stringify(row.Item)).not.toContain('monstera');
  });
});
