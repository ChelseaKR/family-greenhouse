import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/plantIdentification.js');
vi.mock('../../../src/services/identifyBudget.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));

import * as identifyBudget from '../../../src/services/identifyBudget.js';
import * as billing from '../../../src/services/billing.js';

// Identify doesn't require a household, so claims omit custom:household_id —
// that also keeps authMiddleware from hitting the membership table.
function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ image: 'A'.repeat(100) }),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/plants/identify',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: { sub: 'user-1', email: 'a@b.com' },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

describe('plants identify handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    // Metering defaults: enforcement OFF (the beta posture), nothing used,
    // real per-plan allowances.
    vi.mocked(identifyBudget.meteringEnabled).mockReturnValue(false);
    vi.mocked(identifyBudget.getUsage).mockResolvedValue(0);
    vi.mocked(identifyBudget.incrementUsage).mockResolvedValue(1);
    vi.mocked(identifyBudget.reserveUsage).mockResolvedValue(1);
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    vi.mocked(plantIdentification.isPlantIdentificationConfigured).mockReturnValue(true);
    vi.mocked(identifyBudget.allowanceForPlan).mockImplementation(
      (planId) => ({ seedling: 3, garden: 30, greenhouse: 100 })[planId]
    );
  });

  it('returns suggestions on success', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({
      configured: true,
      suggestions: [
        { scientificName: 'Monstera deliciosa', commonName: 'Monstera', probability: 0.95 },
      ],
    });
    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).suggestions).toHaveLength(1);
  });

  it('accepts a schema-in-spec image close to the 350,000-char cap (regression: bodySizeGuard used to reject these with a 413 before the schema ever ran)', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({
      configured: true,
      suggestions: [],
    });
    const res = (await identify(
      buildEvent({ body: JSON.stringify({ image: 'A'.repeat(340_000) }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
  });

  it('always returns usage info ({used, allowance, meteringEnabled}) and meters successful calls', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({
      configured: true,
      suggestions: [],
    });
    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).usage).toEqual({ used: 1, allowance: 3, meteringEnabled: false });
    // No household claim → personal bucket on the free-tier allowance, and no
    // subscription lookup at all.
    expect(identifyBudget.incrementUsage).toHaveBeenCalledWith('user:user-1');
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('does NOT meter a not-configured fallback (no Plant.id credit was spent)', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({ configured: false });
    vi.mocked(plantIdentification.isPlantIdentificationConfigured).mockReturnValueOnce(false);
    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(identifyBudget.incrementUsage).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).usage).toEqual({ used: 0, allowance: 3, meteringEnabled: false });
  });

  it('a failed budget READ is published as unknown, not as "0 used this month"', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    // getUsage now answers `null` when DynamoDB would not tell it anything.
    vi.mocked(identifyBudget.getUsage).mockResolvedValue(null);
    vi.mocked(identifyBudget.incrementUsage).mockResolvedValue(null);
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({ configured: false });
    vi.mocked(plantIdentification.isPlantIdentificationConfigured).mockReturnValueOnce(false);

    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    // Still fails open — the identification itself succeeded. But the caller
    // is told the total is unknown rather than being handed a confident zero.
    expect(JSON.parse(res.body).usage).toEqual({
      used: null,
      allowance: 3,
      meteringEnabled: false,
    });
  });

  it('a failed budget INCREMENT is unknown, not an unverified used+1 estimate', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(identifyBudget.getUsage).mockResolvedValue(4);
    // The ADD never landed, so the stored total is still 4 — publishing 5
    // reported a number that is wrong in exactly the case that produced it.
    vi.mocked(identifyBudget.incrementUsage).mockResolvedValue(null);
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({
      configured: true,
      suggestions: [],
    });

    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).usage.used).toBeNull();
  });

  it('enforces the allowance with a 402 (plan name + upgrade pointer) ONLY when metering is enabled', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(identifyBudget.meteringEnabled).mockReturnValue(true);
    vi.mocked(identifyBudget.reserveUsage).mockRejectedValueOnce(
      new identifyBudget.IdentifyBudgetExceededError()
    );

    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Seedling plan is limited to 3 plant identifications/);
    expect(body.message).toMatch(/Upgrade/);
    // The paid upstream must never be hit for a blocked call.
    expect(plantIdentification.identifyPlant).not.toHaveBeenCalled();
  });

  it('with metering DISABLED (the beta default) an over-allowance household still identifies', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(identifyBudget.meteringEnabled).mockReturnValue(false);
    vi.mocked(identifyBudget.getUsage).mockResolvedValue(50); // way past every allowance
    vi.mocked(identifyBudget.incrementUsage).mockResolvedValue(51);
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({
      configured: true,
      suggestions: [],
    });
    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).usage).toEqual({
      used: 51,
      allowance: 3,
      meteringEnabled: false,
    });
  });

  it('fails closed before the paid upstream when the enforced reservation cannot be recorded', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(identifyBudget.meteringEnabled).mockReturnValue(true);
    vi.mocked(identifyBudget.reserveUsage).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/temporarily unavailable/i);
    expect(plantIdentification.identifyPlant).not.toHaveBeenCalled();
  });

  it('applies the per-plan allowance from the household subscription (garden → 30)', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    setCachedMembership('user-1', 'hh-1', 'member');
    const { identify } = await import('../../../src/handlers/plants/identify.js');

    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' });
    vi.mocked(identifyBudget.meteringEnabled).mockReturnValue(true);
    vi.mocked(identifyBudget.reserveUsage).mockResolvedValue(6);
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValueOnce({
      configured: true,
      suggestions: [],
    });

    const event = buildEvent({
      requestContext: {
        authorizer: {
          claims: { sub: 'user-1', email: 'a@b.com', 'custom:household_id': 'hh-1' },
        },
        identity: { sourceIp: '127.0.0.1' },
      } as APIGatewayProxyEvent['requestContext'],
    });
    const res = (await identify(event, ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).usage).toEqual({ used: 6, allowance: 30, meteringEnabled: true });
    // Household callers meter on the household bucket, not the user.
    expect(identifyBudget.reserveUsage).toHaveBeenCalledWith('hh-1', 30);
    expect(identifyBudget.getUsage).not.toHaveBeenCalled();
    expect(identifyBudget.incrementUsage).not.toHaveBeenCalled();
  });

  it('surfaces upstream failures as an exposed 502 message', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(plantIdentification.identifyPlant).mockRejectedValueOnce(
      new Error('plant.id timed out after 5000ms')
    );
    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(502);
    // The 502 is intentionally exposed so the frontend can show the cause.
    expect(res.body).toMatch(/Plant identification failed: plant\.id timed out/);
    // A failed call consumed nothing and must not be metered.
    expect(identifyBudget.incrementUsage).not.toHaveBeenCalled();
  });

  it('rate limits the metered endpoint at 10/min per user', async () => {
    const plantIdentification = await import('../../../src/services/plantIdentification.js');
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    vi.mocked(plantIdentification.identifyPlant).mockResolvedValue({
      configured: true,
      suggestions: [],
    });
    for (let i = 0; i < 10; i++) {
      const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
    }
    const res = (await identify(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(429);
    // The 11th call must never reach the paid upstream.
    expect(plantIdentification.identifyPlant).toHaveBeenCalledTimes(10);
  });

  it('still requires authentication', async () => {
    const { identify } = await import('../../../src/handlers/plants/identify.js');
    const event = buildEvent();
    delete (event.requestContext as { authorizer?: unknown }).authorizer;
    const res = (await identify(event, ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
  });
});
