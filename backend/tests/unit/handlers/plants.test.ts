import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/cognitoUsers.js', () => ({
  getUserName: vi.fn(async () => 'Tester'),
}));
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: vi.fn(),
  S3Client: vi.fn(() => ({})),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://upload.example.test/signed'),
}));
vi.mock('../../../src/utils/s3.js', () => ({
  s3: {},
  IMAGES_BUCKET: 'test-bucket',
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
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
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const fakeContext = {} as Context;

describe('plants handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Activity recording is fire-and-forget; auto-mock would return undefined
    // and crash the `.catch()` chain. Resolve to undefined instead.
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
  });

  it('listPlants returns plants for the caller household', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { listPlants } = await import('../../../src/handlers/plants/handler.js');

    vi.mocked(plantService.getPlants).mockResolvedValueOnce([
      {
        id: 'p1',
        householdId: 'hh-1',
        name: 'Pothos',
        species: null,
        location: null,
        imageUrl: null,
        notes: null,
        createdAt: '',
        createdBy: '',
        updatedAt: '',
      },
    ]);

    const res = (await listPlants(buildEvent(), fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(plantService.getPlants).toHaveBeenCalledWith('hh-1', 'active');
  });

  it('listPlants returns 403 when user has no household', async () => {
    const { listPlants } = await import('../../../src/handlers/plants/handler.js');
    const event = buildEvent();
    (event.requestContext.authorizer as { claims: Record<string, unknown> }).claims = {
      sub: 'u',
      email: 'e',
    };
    const res = (await listPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('listPlants returns 401 when no claims', async () => {
    const { listPlants } = await import('../../../src/handlers/plants/handler.js');
    const event = buildEvent();
    delete (event.requestContext as { authorizer?: unknown }).authorizer;
    const res = (await listPlants(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
  });

  it('createPlant validates the body and returns 400 on bad input', async () => {
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ name: '' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('createPlant creates a plant with valid input', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([]); // under cap
    vi.mocked(plantService.createPlant).mockResolvedValueOnce({
      id: 'p2',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Pothos' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    expect(plantService.createPlant).toHaveBeenCalledWith({ name: 'Pothos' }, 'hh-1', 'user-1');
  });

  it('createPlant returns 402 when plan cap reached', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
    // 10 existing plants on Seedling => at cap
    vi.mocked(plantService.getPlants).mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        householdId: 'hh-1',
        name: 'x',
        species: null,
        location: null,
        imageUrl: null,
        notes: null,
        createdAt: '',
        createdBy: '',
        updatedAt: '',
      }))
    );
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'eleventh' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
  });

  it('getPlant returns 404 if plant is not found', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { getPlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
    const event = buildEvent({ pathParameters: { id: 'missing' } });
    const res = (await getPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('getPlant returns plant with upcomingTasks and recentCompletions', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const { getPlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    vi.mocked(taskService.getTasksForPlant).mockResolvedValueOnce([]);
    vi.mocked(taskService.getTaskCompletions).mockResolvedValueOnce([]);

    const event = buildEvent({ pathParameters: { id: 'p1' } });
    const res = (await getPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      id: 'p1',
      upcomingTasks: [],
      recentCompletions: [],
    });
  });

  it('updatePlant returns 404 when plant missing', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.updatePlant).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'PUT',
      pathParameters: { id: 'missing' },
      body: JSON.stringify({ name: 'New' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await updatePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('deletePlant returns 204 on success', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { deletePlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.deletePlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      tags: [],
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    const event = buildEvent({
      httpMethod: 'DELETE',
      pathParameters: { id: 'p1' },
    });
    const res = (await deletePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(plantService.deletePlant).toHaveBeenCalledWith('hh-1', 'p1');
  });

  it('deletePlant returns 404 when service reports plant not found', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { deletePlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.deletePlant).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'DELETE',
      pathParameters: { id: 'missing' },
    });
    const res = (await deletePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('getImageUploadUrl returns presigned URL but does not commit imageUrl', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { getImageUploadUrl } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 'p1' },
    });
    const res = (await getImageUploadUrl(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.uploadUrl).toBe('https://upload.example.test/signed');
    expect(body.imageUrl).toContain('test-bucket');
    // Regression check on a previously-removed code path: getImageUploadUrl
    // must not mutate plant state until the client calls /image/confirm.
    // (updatePlantImage itself was deleted 2026-06-01 — appendPlantPhoto
    //  is the only writer now.)
  });

  it('confirmImageUpload writes imageUrl after a matching key is presented', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    vi.mocked(plantService.appendPlantPhoto).mockResolvedValueOnce({
      id: 'photo-1',
      plantId: 'p1',
      imageUrl: 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg',
      uploadedBy: 'user-1',
      uploadedAt: '',
      caption: null,
    });
    const url = 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg';
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 'p1' },
      body: JSON.stringify({ imageUrl: url }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    // appendPlantPhoto is the only writer (updates the primary imageUrl
    // atomically via a TransactWriteCommand).
    expect(plantService.appendPlantPhoto).toHaveBeenCalledWith('hh-1', 'p1', url, 'user-1');
  });

  it('confirmImageUpload rejects URLs from a different plant prefix', async () => {
    const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 'p1' },
      body: JSON.stringify({
        imageUrl: 'https://test-bucket.s3.amazonaws.com/plants/hh-1/OTHER/abc.jpg',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });
});
