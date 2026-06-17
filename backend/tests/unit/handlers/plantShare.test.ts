/**
 * Unit tests for the propagation (parentPlantId / lineage) and cutting-share
 * additions to handlers/plants/handler.ts. Services are mocked — the
 * service-level behavior (snapshotting, TTL, lineage filtering) is covered
 * in tests/unit/services/plantShare.test.ts and the end-to-end flow in
 * tests/integration/propagation-share.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

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
  // Used by the share preview/accept handlers to resolve the SOURCE
  // household's display name.
  getHousehold: vi.fn(async () => ({
    id: 'hh-2',
    name: 'Source House',
    createdAt: '',
    createdBy: 'user-9',
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

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';

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

const parentPlant = {
  id: PARENT_ID,
  householdId: 'hh-1',
  name: 'Mother Monstera',
  species: 'Monstera deliciosa',
  location: null,
  imageUrl: null,
  notes: null,
  status: 'active' as const,
  statusChangedAt: null,
  tags: [],
  perenualSpeciesId: null,
  parentPlantId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const sampleShare = {
  code: 'a'.repeat(32),
  plantId: PARENT_ID,
  householdId: 'hh-2',
  plantSnapshot: {
    name: 'Mother Monstera',
    species: 'Monstera deliciosa',
    notes: 'thrives in the east window',
    imageUrl: null,
    tags: ['tropical'],
  },
  createdBy: 'user-9',
  createdAt: '2026-06-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('plants handler — propagation + shares', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  describe('createPlant with parentPlantId', () => {
    it('rejects a nonexistent / cross-household parent with 400 and never creates', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { createPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
      const event = buildEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ name: 'Cutting', parentPlantId: PARENT_ID }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Parent plant not found/);
      expect(plantService.getPlant).toHaveBeenCalledWith('hh-1', PARENT_ID);
      expect(plantService.createPlant).not.toHaveBeenCalled();
    });

    it('rejects a non-uuid parentPlantId at validation (400)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { createPlant } = await import('../../../src/handlers/plants/handler.js');
      const event = buildEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ name: 'Cutting', parentPlantId: 'not-a-uuid' }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(plantService.createPlant).not.toHaveBeenCalled();
    });

    it('creates the cutting when the parent exists and records plant.propagated', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const activity = await import('../../../src/services/activity.js');
      const { createPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(parentPlant);
      vi.mocked(plantService.createPlant).mockResolvedValueOnce({
        ...parentPlant,
        id: CHILD_ID,
        name: 'Cutting',
        parentPlantId: PARENT_ID,
      });
      const event = buildEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ name: 'Cutting', parentPlantId: PARENT_ID }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await createPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(201);
      expect(plantService.createPlant).toHaveBeenCalledWith(
        { name: 'Cutting', parentPlantId: PARENT_ID },
        'hh-1',
        'user-1',
        500
      );
      // Parented create records the more specific event type.
      expect(activity.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'plant.propagated',
          payload: expect.objectContaining({
            parentPlantId: PARENT_ID,
            parentPlantName: 'Mother Monstera',
          }),
        })
      );
    });
  });

  describe('updatePlant parentPlantId validation', () => {
    it('rejects self-parenting with 400', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
      const event = buildEvent({
        httpMethod: 'PUT',
        pathParameters: { id: PARENT_ID },
        body: JSON.stringify({ parentPlantId: PARENT_ID }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await updatePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/own parent/);
      expect(plantService.updatePlant).not.toHaveBeenCalled();
    });

    it('rejects a nonexistent parent with 400', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
      const event = buildEvent({
        httpMethod: 'PUT',
        pathParameters: { id: CHILD_ID },
        body: JSON.stringify({ parentPlantId: PARENT_ID }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await updatePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(plantService.updatePlant).not.toHaveBeenCalled();
    });

    it('allows detaching with an explicit null (no parent lookup)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { updatePlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.updatePlant).mockResolvedValueOnce({
        ...parentPlant,
        id: CHILD_ID,
        parentPlantId: null,
      });
      const event = buildEvent({
        httpMethod: 'PUT',
        pathParameters: { id: CHILD_ID },
        body: JSON.stringify({ parentPlantId: null }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await updatePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(plantService.getPlant).not.toHaveBeenCalled();
      expect(plantService.updatePlant).toHaveBeenCalledWith('hh-1', CHILD_ID, {
        parentPlantId: null,
      });
    });
  });

  describe('getPlant lineage', () => {
    it('includes the lineage block alongside tasks and completions', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const taskService = await import('../../../src/services/taskService.js');
      const { getPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlant).mockResolvedValueOnce({
        ...parentPlant,
        id: CHILD_ID,
        parentPlantId: PARENT_ID,
      });
      vi.mocked(taskService.getTasksForPlant).mockResolvedValueOnce([]);
      vi.mocked(taskService.getTaskCompletions).mockResolvedValueOnce([]);
      vi.mocked(plantService.getLineage).mockResolvedValueOnce({
        parent: { id: PARENT_ID, name: 'Mother Monstera', status: 'active' },
        children: [{ id: 'c-2', name: 'Dead Cutting', status: 'died', createdAt: '2026-02-01' }],
      });

      const event = buildEvent({ pathParameters: { id: CHILD_ID } });
      const res = (await getPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.lineage).toEqual({
        parent: { id: PARENT_ID, name: 'Mother Monstera', status: 'active' },
        children: [{ id: 'c-2', name: 'Dead Cutting', status: 'died', createdAt: '2026-02-01' }],
      });
      expect(plantService.getLineage).toHaveBeenCalledWith('hh-1', CHILD_ID, PARENT_ID);
    });
  });

  describe('sharePlant', () => {
    it('returns 201 with code + frontend URL', async () => {
      vi.stubEnv('FRONTEND_URL', 'https://familygreenhouse.net');
      const plantService = await import('../../../src/services/plantService.js');
      const { sharePlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.createPlantShare).mockResolvedValueOnce(sampleShare);
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: PARENT_ID },
      });
      const res = (await sharePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.code).toBe(sampleShare.code);
      expect(body.url).toBe(`https://familygreenhouse.net/shared/${sampleShare.code}`);
      expect(body.expiresAt).toBe(sampleShare.expiresAt);
      expect(plantService.createPlantShare).toHaveBeenCalledWith('hh-1', PARENT_ID, 'user-1');
    });

    it('returns 404 when the plant is not in the caller household', async () => {
      vi.stubEnv('FRONTEND_URL', 'https://familygreenhouse.net');
      const plantService = await import('../../../src/services/plantService.js');
      const { sharePlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.createPlantShare).mockResolvedValueOnce(null);
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: PARENT_ID },
      });
      const res = (await sharePlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
    });
  });

  describe('getSharedPlant (public)', () => {
    it('serves the snapshot WITHOUT any auth claims (auth: none route)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { getSharedPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(sampleShare);
      const event = buildEvent({ pathParameters: { code: sampleShare.code } });
      // No authorizer at all — exactly what an anonymous recipient sends.
      delete (event.requestContext as { authorizer?: unknown }).authorizer;
      const res = (await getSharedPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.plant).toEqual(sampleShare.plantSnapshot);
      expect(body.householdName).toBe('Source House');
      // No PII beyond household name + the plant card.
      expect(body).not.toHaveProperty('createdBy');
      expect(JSON.stringify(body)).not.toMatch(/user-9|hh-2/);
    });

    it('returns 404 for unknown or expired codes', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { getSharedPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(null);
      const event = buildEvent({ pathParameters: { code: 'f'.repeat(32) } });
      delete (event.requestContext as { authorizer?: unknown }).authorizer;
      const res = (await getSharedPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
    });
  });

  describe('acceptSharedPlant', () => {
    it('copies the snapshot into the CALLER household with a provenance note', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const activity = await import('../../../src/services/activity.js');
      const { acceptSharedPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(sampleShare);
      vi.mocked(plantService.createPlant).mockResolvedValueOnce({
        ...parentPlant,
        id: CHILD_ID,
        householdId: 'hh-1',
      });
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { code: sampleShare.code },
      });
      const res = (await acceptSharedPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(201);
      expect(plantService.createPlant).toHaveBeenCalledWith(
        {
          name: 'Mother Monstera',
          species: 'Monstera deliciosa',
          notes: 'Cutting from Source House\n\nthrives in the east window',
          tags: ['tropical'],
        },
        'hh-1', // the ACCEPTOR's household, not the share's
        'user-1',
        500
      );
      expect(activity.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'plant.shared_accepted',
          householdId: 'hh-1',
          payload: expect.objectContaining({ fromHouseholdName: 'Source House' }),
        })
      );
    });

    it('maps the plan cap to 402 (PlanLimitError path)', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const billing = await import('../../../src/services/billing.js');
      const { acceptSharedPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
      vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(sampleShare);
      vi.mocked(plantService.createPlant).mockRejectedValueOnce(
        Object.assign(new Error('Plant limit of 10 reached'), { name: 'PlanLimitError' })
      );
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { code: sampleShare.code },
      });
      const res = (await acceptSharedPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(402);
      expect(res.body).toMatch(/Seedling plan is limited to 10 plants/);
    });

    it('requires authentication (401 without claims)', async () => {
      const { acceptSharedPlant } = await import('../../../src/handlers/plants/handler.js');
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { code: sampleShare.code },
      });
      delete (event.requestContext as { authorizer?: unknown }).authorizer;
      const res = (await acceptSharedPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 for an expired/unknown code', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const { acceptSharedPlant } = await import('../../../src/handlers/plants/handler.js');
      vi.mocked(plantService.getPlantShare).mockResolvedValueOnce(null);
      const event = buildEvent({
        httpMethod: 'POST',
        pathParameters: { code: 'f'.repeat(32) },
      });
      const res = (await acceptSharedPlant(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
    });
  });
});
