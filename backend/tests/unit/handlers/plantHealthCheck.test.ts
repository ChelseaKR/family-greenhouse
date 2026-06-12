import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/leafHealth.js');
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/householdService.js');

import * as leafHealth from '../../../src/services/leafHealth.js';
import * as plantService from '../../../src/services/plantService.js';
import * as activity from '../../../src/services/activity.js';
import * as householdService from '../../../src/services/householdService.js';

const ASSESSMENT: leafHealth.LeafHealthAssessment = {
  overall: 'monitor',
  observations: [
    { sign: 'yellowing', confidence: 'high', note: 'Lower leaf edges are turning yellow.' },
  ],
  suggestion: 'Check soil moisture before the next watering.',
  disclaimer: 'This is a cosmetic visual check from a single photo, not a diagnosis.',
};

const PLANT = { id: 'plant-1', name: 'Fernie' } as Awaited<
  ReturnType<typeof plantService.getPlant>
>;

// Health checks are household-scoped (requireHousehold), so claims carry
// custom:household_id and the membership cache is pre-seeded to keep
// authMiddleware off the membership table.
function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ imageBase64: 'A'.repeat(100) }),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/plants/plant-1/health-check',
    pathParameters: { id: 'plant-1' },
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: { sub: 'user-1', email: 'a@b.com', 'custom:household_id': 'hh-1' },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

async function subject() {
  return (await import('../../../src/handlers/plants/health.js')).checkPlantHealth;
}

describe('plants health-check handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    __resetMembershipCacheForTests();
    setCachedMembership('user-1', 'hh-1', 'member');

    vi.mocked(plantService.getPlant).mockResolvedValue(PLANT);
    vi.mocked(leafHealth.assessLeafHealth).mockResolvedValue(ASSESSMENT);
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue({
      name: 'Chelsea',
    } as Awaited<ReturnType<typeof householdService.getMemberByUserId>>);
  });

  it('returns the assessment and records a plant.health_checked activity row', async () => {
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(ASSESSMENT);
    // Ownership lookup is household-scoped.
    expect(plantService.getPlant).toHaveBeenCalledWith('hh-1', 'plant-1');
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plant.health_checked',
        householdId: 'hh-1',
        actorId: 'user-1',
        actorName: 'Chelsea',
        payload: { plantId: 'plant-1', plantName: 'Fernie', overall: 'monitor' },
      })
    );
  });

  it("404s when the plant is not in the caller's household (ownership)", async () => {
    vi.mocked(plantService.getPlant).mockResolvedValue(null);
    const checkPlantHealth = await subject();

    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    // No Bedrock spend for a plant the caller doesn't own.
    expect(leafHealth.assessLeafHealth).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('400s when imageBase64 is absent (analyzing by reference is not supported in V1)', async () => {
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(
      buildEvent({ body: JSON.stringify({}) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(leafHealth.assessLeafHealth).not.toHaveBeenCalled();
  });

  it('maps an unparseable model reply to an exposed 502 "could not analyze"', async () => {
    const parseErr = new Error('model JSON did not match the assessment schema');
    parseErr.name = 'LeafHealthParseError';
    vi.mocked(leafHealth.assessLeafHealth).mockRejectedValue(parseErr);
    const checkPlantHealth = await subject();

    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/Could not analyze the photo/);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('surfaces transport failures as an exposed 502 message and records no activity', async () => {
    vi.mocked(leafHealth.assessLeafHealth).mockRejectedValue(
      new Error('Bedrock timed out after 5000ms')
    );
    const checkPlantHealth = await subject();

    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/Leaf health check failed: Bedrock timed out/);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('rate limits at 5/min per user (the 6th call never reaches Bedrock)', async () => {
    const checkPlantHealth = await subject();
    for (let i = 0; i < 5; i++) {
      const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
    }
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    expect(leafHealth.assessLeafHealth).toHaveBeenCalledTimes(5);
  });

  it('requires authentication', async () => {
    const checkPlantHealth = await subject();
    const event = buildEvent();
    delete (event.requestContext as { authorizer?: unknown }).authorizer;

    const res = (await checkPlantHealth(event, ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
  });

  it('requires a household', async () => {
    const checkPlantHealth = await subject();
    const event = buildEvent({
      requestContext: {
        authorizer: { claims: { sub: 'user-2', email: 'b@c.com' } },
        identity: { sourceIp: '127.0.0.1' },
      } as APIGatewayProxyEvent['requestContext'],
    });

    const res = (await checkPlantHealth(event, ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });
});
