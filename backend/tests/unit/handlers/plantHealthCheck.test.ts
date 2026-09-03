import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/leafHealth.js');
vi.mock('../../../src/services/leafHealthBudget.js');
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));

import * as leafHealth from '../../../src/services/leafHealth.js';
import * as leafHealthBudget from '../../../src/services/leafHealthBudget.js';
import * as plantService from '../../../src/services/plantService.js';
import * as activity from '../../../src/services/activity.js';
import * as householdService from '../../../src/services/householdService.js';
import * as billing from '../../../src/services/billing.js';

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
    // Spend cap (M1): resolve the household's cap (the flat 200 by default)
    // and atomically reserve one invocation.
    vi.mocked(leafHealthBudget.resolveMonthlyCap).mockResolvedValue(200);
    vi.mocked(leafHealthBudget.reserveUsage).mockResolvedValue(1);
    vi.mocked(leafHealthBudget.releaseUsage).mockResolvedValue(undefined);
    vi.mocked(leafHealthBudget.incrementUsage).mockResolvedValue(1);
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
        payload: {
          plantId: 'plant-1',
          plantName: 'Fernie',
          overall: 'monitor',
          demo: false,
        },
      })
    );
    // A real (non-demo) assessment was reserved before Bedrock ran.
    expect(leafHealthBudget.reserveUsage).toHaveBeenCalledWith('hh-1', 200);
    expect(leafHealthBudget.incrementUsage).not.toHaveBeenCalled();
    // The plan lookup lives inside the closure handed to resolveMonthlyCap,
    // so on the flat-cap path (the default) the household row is never read.
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('accepts a schema-in-spec image close to the 350,000-char cap (regression: bodySizeGuard used to reject these with a 413 before the schema ever ran)', async () => {
    const checkPlantHealth = await subject();
    // 340,000 chars is within the schema's own 350,000-char allowance — the
    // frontend's client-side pre-check and the Zod schema both treat this as
    // fine. The old global 256 KiB (262,144-byte) bodySizeGuard default
    // rejected the wrapping JSON body for any image above ~262,000 chars,
    // well inside this "should be fine" range — exactly what real iPhone
    // leaf close-ups were hitting.
    const res = (await checkPlantHealth(
      buildEvent({ body: JSON.stringify({ imageBase64: 'A'.repeat(340_000) }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
  });

  it('429s and never calls Bedrock when the household is over its monthly cap (M1)', async () => {
    const limitError = new Error('at cap');
    limitError.name = 'LeafHealthBudgetExceededError';
    vi.mocked(leafHealthBudget.reserveUsage).mockRejectedValue(limitError);
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    expect(leafHealth.assessLeafHealth).not.toHaveBeenCalled();
    expect(leafHealthBudget.incrementUsage).not.toHaveBeenCalled();
  });

  it('releases the reservation for the demo fallback (no Bedrock spend)', async () => {
    vi.mocked(leafHealth.assessLeafHealth).mockResolvedValue({ ...ASSESSMENT, demo: true });
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(leafHealthBudget.releaseUsage).toHaveBeenCalledWith('hh-1');
    expect(leafHealthBudget.incrementUsage).not.toHaveBeenCalled();
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plant.health_checked',
        payload: expect.objectContaining({
          plantId: 'plant-1',
          overall: 'monitor',
          demo: true,
        }),
      })
    );
  });

  it('fails closed before Bedrock when the atomic reservation is unavailable', async () => {
    vi.mocked(leafHealthBudget.reserveUsage).mockRejectedValue(new Error('ddb down'));
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/temporarily unavailable/i);
    expect(leafHealth.assessLeafHealth).not.toHaveBeenCalled();
  });

  it('resolves a tier-aware cap through the household plan (the lookup identify uses) and reserves against it', async () => {
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'greenhouse',
    } as Awaited<ReturnType<typeof billing.getHouseholdSubscription>>);
    vi.mocked(leafHealthBudget.resolveMonthlyCap).mockImplementation(async (lookupPlanId) =>
      (await lookupPlanId()) === 'greenhouse' ? 400 : 200
    );
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-1');
    expect(leafHealthBudget.reserveUsage).toHaveBeenCalledWith('hh-1', 400);
  });

  it('503s before Bedrock when the cap cannot be resolved (a cap we cannot determine is not one to spend against)', async () => {
    vi.mocked(leafHealthBudget.resolveMonthlyCap).mockRejectedValue(new Error('ddb down'));
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/temporarily unavailable/i);
    expect(leafHealthBudget.reserveUsage).not.toHaveBeenCalled();
    expect(leafHealth.assessLeafHealth).not.toHaveBeenCalled();
  });

  it('still tracks real checks when the configured cap is unlimited', async () => {
    vi.mocked(leafHealthBudget.resolveMonthlyCap).mockResolvedValue(0);
    const checkPlantHealth = await subject();
    const res = (await checkPlantHealth(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(leafHealthBudget.reserveUsage).not.toHaveBeenCalled();
    expect(leafHealthBudget.incrementUsage).toHaveBeenCalledWith('hh-1');
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
