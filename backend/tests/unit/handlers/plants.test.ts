import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/spaceService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
// Serves double duty: authMiddleware validates the claim household against
// this membership row, and the handler reads the denormalized member name
// for activity attribution (replaced the per-request Cognito AdminGetUser).
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
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: vi.fn(function (input) {
    return { input };
  }),
  HeadObjectCommand: vi.fn(function (input) {
    return { __type: 'Head', input };
  }),
  DeleteObjectCommand: vi.fn(function (input) {
    return { __type: 'Delete', input };
  }),
  S3Client: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://upload.example.test/signed'),
}));
vi.mock('../../../src/utils/s3.js', () => ({
  s3: { send: vi.fn() },
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
    vi.unstubAllEnvs();
    // Activity recording is fire-and-forget; auto-mock would return undefined
    // and crash the `.catch()` chain. Resolve to undefined instead.
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
    // Per-test isolation for the membership cache and in-memory rate limits.
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  it('lists spaces for the caller household', async () => {
    const spaceService = await import('../../../src/services/spaceService.js');
    const { listSpaces } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(spaceService.getSpaces).mockResolvedValueOnce([
      {
        id: 'space-1',
        householdId: 'hh-1',
        name: 'Kitchen',
        environment: 'inside',
        createdAt: '',
        createdBy: 'user-1',
        updatedAt: '',
      },
    ]);
    const res = (await listSpaces(buildEvent(), fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(spaceService.getSpaces).toHaveBeenCalledWith('hh-1');
  });

  it('refuses to create a plant in another household space', async () => {
    const spaceService = await import('../../../src/services/spaceService.js');
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(spaceService.getSpace).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        name: 'Pothos',
        spaceId: '550e8400-e29b-41d4-a716-446655440099',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/Space not found/);
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

  it('createPlant creates a plant with valid input, passing the plan cap to the service', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
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
    // Cap enforcement is atomic inside the service (transactional counter);
    // the handler's job is to resolve the plan and hand the cap down.
    // Default billing mock = garden plan → maxPlants 500.
    expect(plantService.createPlant).toHaveBeenCalledWith(
      { name: 'Pothos' },
      'hh-1',
      'user-1',
      500
    );
    // The old count-then-write pre-check is gone — no plant listing on create.
    expect(plantService.getPlants).not.toHaveBeenCalled();
  });

  it('createPlant returns 402 naming the plan when the service reports the cap (PlanLimitError)', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
    // The transactional counter condition lost — e.g. a concurrent create
    // took the last Seedling slot (TransactionCanceled → PlanLimitError).
    vi.mocked(plantService.createPlant).mockRejectedValueOnce(
      Object.assign(new Error('Plant limit of 10 reached'), { name: 'PlanLimitError' })
    );
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'eleventh' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatch(/Seedling plan is limited to 10 plants/);
    expect(plantService.createPlant).toHaveBeenCalledWith(
      { name: 'eleventh' },
      'hh-1',
      'user-1',
      10
    );
  });

  it('createPlant rethrows non-cap service failures as 500', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createPlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.createPlant).mockRejectedValueOnce(new Error('DDB down'));
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Pothos' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(500);
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

  it.each([
    ['active', 'archived', 'plant.archived'],
    ['archived', 'active', 'plant.restored'],
  ] as const)('records a real %s → %s lifecycle transition as %s', async (before, after, type) => {
    const plantService = await import('../../../src/services/plantService.js');
    const activity = await import('../../../src/services/activity.js');
    const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      status: before,
    } as never);
    vi.mocked(plantService.updatePlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      status: after,
    } as never);

    const res = (await updatePlant(
      buildEvent({
        httpMethod: 'PUT',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ status: after }),
        headers: { 'content-type': 'application/json' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type,
        householdId: 'hh-1',
        payload: { plantId: 'p1', plantName: 'Pothos', previousStatus: before },
      })
    );
  });

  it('does not duplicate an archive activity on an idempotent retry', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const activity = await import('../../../src/services/activity.js');
    const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
    const archived = {
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      status: 'archived',
    } as never;
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(archived);
    vi.mocked(plantService.updatePlant).mockResolvedValueOnce(archived);

    const res = (await updatePlant(
      buildEvent({
        httpMethod: 'PUT',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ status: 'archived' }),
        headers: { 'content-type': 'application/json' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(activity.recordActivity).not.toHaveBeenCalled();
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

  const seedPlant = {
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
  };

  describe('getImageUploadUrl', () => {
    it('returns presigned URL but does not commit imageUrl (defaults to jpeg)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { getImageUploadUrl } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
      });
      const res = (await getImageUploadUrl(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.uploadUrl).toBe('https://upload.example.test/signed');
      // No ASSETS_BASE_URL in unit tests → raw S3 URL form.
      expect(body.imageUrl).toMatch(
        /^https:\/\/test-bucket\.s3\.amazonaws\.com\/plants\/hh-1\/p1\/[A-Za-z0-9-]+\.jpg$/
      );
      // The presigned PUT is signed for the default content type.
      expect(vi.mocked(PutObjectCommand).mock.calls[0][0]).toMatchObject({
        Bucket: 'test-bucket',
        ContentType: 'image/jpeg',
      });
      // Regression check on a previously-removed code path: getImageUploadUrl
      // must not mutate plant state until the client calls /image/confirm.
      expect(plantService.appendPlantPhoto).not.toHaveBeenCalled();
    });

    it('signs for an allowlisted contentType and uses the matching extension', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { getImageUploadUrl } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ contentType: 'image/webp' }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await getImageUploadUrl(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.imageUrl).toMatch(/\.webp$/);
      expect(vi.mocked(PutObjectCommand).mock.calls[0][0]).toMatchObject({
        ContentType: 'image/webp',
      });
      expect(vi.mocked(PutObjectCommand).mock.calls[0][0].Key).toMatch(/\.webp$/);
    });

    it('rejects a non-allowlisted contentType with 400', async () => {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const { getImageUploadUrl } = await import('../../../src/handlers/plants/handler.js');
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ contentType: 'image/gif' }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await getImageUploadUrl(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
    });

    it('rejects image/svg+xml (XSS vector) with 400', async () => {
      const { getImageUploadUrl } = await import('../../../src/handlers/plants/handler.js');
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ contentType: 'image/svg+xml' }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await getImageUploadUrl(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
    });

    it('mints the imageUrl from ASSETS_BASE_URL when set', async () => {
      vi.stubEnv('ASSETS_BASE_URL', 'https://familygreenhouse.net/');
      const plantService = await import('../../../src/services/plantService.js');
      const { getImageUploadUrl } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ contentType: 'image/png' }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await getImageUploadUrl(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Trailing slash on the env var must not produce a double slash.
      expect(body.imageUrl).toMatch(
        /^https:\/\/familygreenhouse\.net\/plants\/hh-1\/p1\/[A-Za-z0-9-]+\.png$/
      );
    });
  });

  describe('confirmImageUpload', () => {
    function mockHeadOk(contentLength = 1234, contentType = 'image/jpeg') {
      return import('../../../src/utils/s3.js').then(({ s3 }) => {
        (s3.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          ContentLength: contentLength,
          ContentType: contentType,
        });
      });
    }

    it('writes imageUrl after a matching key is presented and HeadObject passes', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      await mockHeadOk();
      const url = 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg';
      vi.mocked(plantService.appendPlantPhoto).mockResolvedValueOnce({
        id: 'photo-1',
        plantId: 'p1',
        imageUrl: url,
        uploadedBy: 'user-1',
        uploadedAt: '',
        caption: null,
      });
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
      expect(vi.mocked(HeadObjectCommand).mock.calls[0][0]).toEqual({
        Bucket: 'test-bucket',
        Key: 'plants/hh-1/p1/abc.jpg',
      });
    });

    it('accepts the ASSETS_BASE_URL form of the minted URL', async () => {
      vi.stubEnv('ASSETS_BASE_URL', 'https://familygreenhouse.net');
      const plantService = await import('../../../src/services/plantService.js');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      await mockHeadOk();
      const url = 'https://familygreenhouse.net/plants/hh-1/p1/abc.webp';
      vi.mocked(plantService.appendPlantPhoto).mockResolvedValueOnce({
        id: 'photo-1',
        plantId: 'p1',
        imageUrl: url,
        uploadedBy: 'user-1',
        uploadedAt: '',
        caption: null,
      });
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ imageUrl: url }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(plantService.appendPlantPhoto).toHaveBeenCalledWith('hh-1', 'p1', url, 'user-1');
    });

    it('rejects URLs from a different plant prefix', async () => {
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

    it('rejects a smuggled key suffix (extra path segment / bad extension)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      for (const bad of [
        'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg?x=1',
        'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/nested/abc.jpg',
        'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.svg',
      ]) {
        const event = buildEvent({
          httpMethod: 'POST',
          pathParameters: { id: 'p1' },
          body: JSON.stringify({ imageUrl: bad }),
          headers: { 'content-type': 'application/json' },
        });
        const res = (await confirmImageUpload(
          event,
          fakeContext,
          () => {}
        )) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(400);
      }
      expect(plantService.appendPlantPhoto).not.toHaveBeenCalled();
    });

    it('rejects (400) and best-effort deletes an oversized upload', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { s3 } = await import('../../../src/utils/s3.js');
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      const send = s3.send as ReturnType<typeof vi.fn>;
      send.mockResolvedValueOnce({ ContentLength: 6 * 1024 * 1024 }); // HeadObject
      send.mockResolvedValueOnce({}); // best-effort DeleteObject
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({
          imageUrl: 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/5 MiB/);
      expect(plantService.appendPlantPhoto).not.toHaveBeenCalled();
      expect(vi.mocked(DeleteObjectCommand).mock.calls[0][0]).toEqual({
        Bucket: 'test-bucket',
        Key: 'plants/hh-1/p1/abc.jpg',
      });
    });

    it('rejects (400) and best-effort deletes an upload whose real Content-Type is not an allowed image type', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { s3 } = await import('../../../src/utils/s3.js');
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      const send = s3.send as ReturnType<typeof vi.fn>;
      // Client presigned for image/jpeg, but the actual PUT landed with a
      // different Content-Type — the presigned URL can't enforce this.
      send.mockResolvedValueOnce({ ContentLength: 1234, ContentType: 'text/html' }); // HeadObject
      send.mockResolvedValueOnce({}); // best-effort DeleteObject
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({
          imageUrl: 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/not a valid image/i);
      expect(plantService.appendPlantPhoto).not.toHaveBeenCalled();
      expect(vi.mocked(DeleteObjectCommand).mock.calls[0][0]).toEqual({
        Bucket: 'test-bucket',
        Key: 'plants/hh-1/p1/abc.jpg',
      });
    });

    it('confirms successfully when the real Content-Type matches the claimed/allowed type', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      await mockHeadOk(1234, 'image/jpeg');
      const url = 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg';
      vi.mocked(plantService.appendPlantPhoto).mockResolvedValueOnce({
        id: 'photo-1',
        plantId: 'p1',
        imageUrl: url,
        uploadedBy: 'user-1',
        uploadedAt: '',
        caption: null,
      });
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ imageUrl: url }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(plantService.appendPlantPhoto).toHaveBeenCalledWith('hh-1', 'p1', url, 'user-1');
    });

    it('rejects (400) when the object was never uploaded (HeadObject 404)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { s3 } = await import('../../../src/utils/s3.js');
      const { confirmImageUpload } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(seedPlant);
      (s3.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('NotFound'), { name: 'NotFound' })
      );
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 'p1' },
        body: JSON.stringify({
          imageUrl: 'https://test-bucket.s3.amazonaws.com/plants/hh-1/p1/abc.jpg',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await confirmImageUpload(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/not found/i);
      expect(plantService.appendPlantPhoto).not.toHaveBeenCalled();
    });
  });
});
