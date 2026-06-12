import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { Plant } from '../../../src/models/types.js';

vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(async () => ({
    householdId: 'hh-1',
    userId: 'user-1',
    name: 'Tester',
    email: 'a@b.com',
    role: 'admin',
    joinedAt: '',
  })),
}));
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'seedling' })),
}));

function buildEvent(body: unknown): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/plants/import',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/plants/import',
    stageVariables: null,
  };
}

const fakeContext = {} as Context;

function fakePlant(id: string, name: string): Plant {
  return {
    id,
    householdId: 'hh-1',
    name,
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    status: 'active',
    statusChangedAt: null,
    tags: [],
    perenualSpeciesId: null,
    createdAt: '',
    createdBy: 'user-1',
    updatedAt: '',
  };
}

describe('POST /plants/import', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  it('returns 400 with per-field details on validation failure', async () => {
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    const event = buildEvent({
      plants: [
        { name: '' }, // empty name
        { name: 'Fern', tasks: [{ type: 'water' }] }, // missing frequency
      ],
    });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Validation failed');
    expect(Object.keys(body.details)).toEqual(
      expect.arrayContaining(['plants.0.name', 'plants.1.tasks.0.frequency'])
    );
  });

  it('rejects more than 100 plants with 400', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    const event = buildEvent({
      plants: Array.from({ length: 101 }, (_, i) => ({ name: `Plant ${i}` })),
    });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).details).toHaveProperty('plants');
    expect(plantService.createPlant).not.toHaveBeenCalled();
  });

  it('rejects a row with more than 10 tasks with 400', async () => {
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    const event = buildEvent({
      plants: [
        {
          name: 'Busy plant',
          tasks: Array.from({ length: 11 }, () => ({ type: 'water', frequency: 7 })),
        },
      ],
    });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).details).toHaveProperty('plants.0.tasks');
  });

  it('creates every row via plantService.createPlant (cap handed down) and returns per-row results', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    vi.mocked(plantService.createPlant)
      .mockResolvedValueOnce(fakePlant('p1', 'Pothos'))
      .mockResolvedValueOnce(fakePlant('p2', 'Monstera'));

    const event = buildEvent({
      plants: [{ name: 'Pothos', tags: ['trailing'] }, { name: 'Monstera' }],
    });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ created: 2, skipped: 0, planLimitHit: false });
    expect(body.results).toEqual([
      { index: 0, status: 'created', plantId: 'p1' },
      { index: 1, status: 'created', plantId: 'p2' },
    ]);
    // Reuses the single-create path — seedling plan cap (10) handed down.
    expect(plantService.createPlant).toHaveBeenNthCalledWith(
      1,
      { name: 'Pothos', tags: ['trailing'] },
      'hh-1',
      'user-1',
      10
    );
  });

  it('creates the per-plant tasks with the new plantId and denormalized plant name', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    vi.mocked(plantService.createPlant).mockResolvedValueOnce(fakePlant('p1', 'Pothos'));

    const event = buildEvent({
      plants: [
        {
          name: 'Pothos',
          tasks: [
            { type: 'water', frequency: 7 },
            { type: 'custom', customType: 'mist', frequency: 3 },
          ],
        },
      ],
    });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
    expect(taskService.createTask).toHaveBeenNthCalledWith(
      1,
      { type: 'water', frequency: 7, plantId: 'p1' },
      'hh-1',
      'user-1',
      'Pothos'
    );
    expect(taskService.createTask).toHaveBeenNthCalledWith(
      2,
      { type: 'custom', customType: 'mist', frequency: 3, plantId: 'p1' },
      'hh-1',
      'user-1',
      'Pothos'
    );
  });

  it('on PlanLimitError marks that row and all remaining rows skipped, still 200 with summary', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    vi.mocked(plantService.createPlant)
      .mockResolvedValueOnce(fakePlant('p1', 'One'))
      .mockResolvedValueOnce(fakePlant('p2', 'Two'))
      .mockRejectedValueOnce(
        Object.assign(new Error('Plant limit of 10 reached'), { name: 'PlanLimitError' })
      );

    const event = buildEvent({
      plants: [
        { name: 'One' },
        { name: 'Two' },
        { name: 'Three', tasks: [{ type: 'water', frequency: 7 }] },
        { name: 'Four' },
      ],
    });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ created: 2, skipped: 2, planLimitHit: true });
    expect(body.results[2]).toMatchObject({ index: 2, status: 'skipped' });
    expect(body.results[2].error).toMatch(/plan limit reached/i);
    expect(body.results[3]).toMatchObject({ index: 3, status: 'skipped' });
    expect(body.results[3].error).toMatch(/plan limit reached/i);
    // The remaining rows never attempt a create (no pointless transactions),
    // and the capped row's tasks are never created.
    expect(plantService.createPlant).toHaveBeenCalledTimes(3);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it('records exactly ONE activity entry for the whole batch', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const activity = await import('../../../src/services/activity.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    vi.mocked(plantService.createPlant)
      .mockResolvedValueOnce(fakePlant('p1', 'One'))
      .mockResolvedValueOnce(fakePlant('p2', 'Two'))
      .mockResolvedValueOnce(fakePlant('p3', 'Three'));

    const event = buildEvent({ plants: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }] });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
    expect(activity.recordActivity).toHaveBeenCalledWith({
      type: 'plants.imported',
      householdId: 'hh-1',
      actorId: 'user-1',
      actorName: 'Tester',
      payload: { count: 3 },
    });
  });

  it('records no activity when nothing was created', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const activity = await import('../../../src/services/activity.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    vi.mocked(plantService.createPlant).mockRejectedValueOnce(
      Object.assign(new Error('Plant limit of 10 reached'), { name: 'PlanLimitError' })
    );
    const event = buildEvent({ plants: [{ name: 'One' }, { name: 'Two' }] });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ created: 0, skipped: 2, planLimitHit: true });
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('a non-cap row failure skips only that row and continues', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { importPlants } = await import('../../../src/handlers/plants/import.js');
    vi.mocked(plantService.createPlant)
      .mockRejectedValueOnce(new Error('DDB hiccup'))
      .mockResolvedValueOnce(fakePlant('p2', 'Two'));
    const event = buildEvent({ plants: [{ name: 'One' }, { name: 'Two' }] });
    const res = (await importPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ created: 1, skipped: 1, planLimitHit: false });
    expect(body.results[0]).toMatchObject({ index: 0, status: 'skipped' });
    expect(body.results[1]).toMatchObject({ index: 1, status: 'created', plantId: 'p2' });
  });
});
