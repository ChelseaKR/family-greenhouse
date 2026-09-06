import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/welcomeEmail.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/accountCleanup.js');
vi.mock('../../../src/services/cognitoUsers.js');
vi.mock('../../../src/services/coverage.js', () => ({
  getCoverageReport: vi.fn(),
}));
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));

function buildEvent(
  claims: Record<string, unknown> | null,
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
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
      authorizer: claims ? { claims } : undefined,
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const fakeContext = {} as Context;

const memberClaims = {
  sub: 'user-1',
  email: 'a@b.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'member',
};

const REPORT = {
  members: [
    { userId: 'user-1', name: 'Priya' },
    { userId: 'user-2', name: 'Sam' },
  ],
  memberCount: 2,
  plantCount: 1,
  plants: [
    {
      plantId: 'p1',
      plantName: 'Monstera',
      caregivers: [{ userId: 'user-1', name: 'Priya' }],
      caregiverCount: 1,
      soleCaregiver: { userId: 'user-1', name: 'Priya' },
    },
  ],
  soleCaregiverPlants: [],
  uncaredPlantCount: 0,
  awayRisks: [],
  generatedAt: '2026-09-03T00:00:00.000Z',
};

describe('GET /households/:id/analytics/coverage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    // Coverage is for every member, not just admins — the person doing all
    // the watering is exactly who needs to see it.
    setCachedMembership('user-1', 'hh-1', 'member');
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);
  });

  it('blocks cross-household callers', async () => {
    const { getCoverage } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-other' } });
    const res = (await getCoverage(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('returns 402 on the free tier without touching the data', async () => {
    const billing = await import('../../../src/services/billing.js');
    const coverage = await import('../../../src/services/coverage.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
    } as never);
    const { getCoverage } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getCoverage(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).message).toMatch(/Garden plan/);
    expect(coverage.getCoverageReport).not.toHaveBeenCalled();
  });

  it.each(['garden', 'greenhouse'])('serves the report on the %s plan', async (planId) => {
    const billing = await import('../../../src/services/billing.js');
    const coverage = await import('../../../src/services/coverage.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId } as never);
    vi.mocked(coverage.getCoverageReport).mockResolvedValueOnce(REPORT as never);
    const { getCoverage } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getCoverage(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(REPORT);
    expect(coverage.getCoverageReport).toHaveBeenCalledWith('hh-1');
  });

  it.each(['past_due', 'unpaid', 'paused'])(
    'returns 402 while the card has failed (%s), without touching the data (#476)',
    async (status) => {
      // A per-request report for a signed-in member of the buying household:
      // nothing issued, nothing in a third party's hands, and the person
      // hitting it is the person who can fix the card. Same treatment as a
      // downgrade.
      const billing = await import('../../../src/services/billing.js');
      const coverage = await import('../../../src/services/coverage.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
        planId: 'garden',
        status,
      } as never);
      const { getCoverage } = await import('../../../src/handlers/households/handler.js');
      const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } });
      const res = (await getCoverage(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(402);
      expect(coverage.getCoverageReport).not.toHaveBeenCalled();
    }
  );

  it('still serves a lifetime Garden owner whose later subscription was cancelled (#476)', async () => {
    // Paired positive control + the entitlement floor.
    const billing = await import('../../../src/services/billing.js');
    const coverage = await import('../../../src/services/coverage.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
      status: 'canceled',
      lifetimePlanId: 'garden',
    } as never);
    vi.mocked(coverage.getCoverageReport).mockResolvedValueOnce(REPORT as never);
    const { getCoverage } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getCoverage(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
  });

  it('surfaces a failed read as an error, never as a report with zero plants at risk', async () => {
    const coverage = await import('../../../src/services/coverage.js');
    vi.mocked(coverage.getCoverageReport).mockRejectedValueOnce(new Error('history read failed'));
    const { getCoverage } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getCoverage(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain('soleCaregiverPlants');
  });
});
