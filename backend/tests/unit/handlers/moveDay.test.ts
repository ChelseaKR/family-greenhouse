import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

// The Move Day endpoint gates on the plan (billing), 404s on a missing
// household, and otherwise delegates to services/moveDay.ts. All three
// surfaces are mocked; the plan catalog itself is real.
vi.mock('../../../src/services/moveDay.js');
vi.mock('../../../src/services/billing.js');
vi.mock('../../../src/services/householdService.js');

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/move-day',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'test@example.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'member',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

async function setup(planId: 'seedling' | 'garden' | 'greenhouse', householdExists = true) {
  const householdService = await import('../../../src/services/householdService.js');
  const billing = await import('../../../src/services/billing.js');
  const moveDay = await import('../../../src/services/moveDay.js');
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();

  vi.mocked(householdService.getMemberByUserId).mockResolvedValue({
    householdId: 'hh-1',
    userId: 'user-1',
    name: 'Tester',
    email: 'test@example.com',
    role: 'member',
    joinedAt: '',
  });
  vi.mocked(householdService.getHousehold).mockResolvedValue(
    householdExists
      ? {
          id: 'hh-1',
          name: 'Home',
          location: { city: 'Portland', lat: 45.5, lon: -122.6 },
          createdAt: '',
          createdBy: 'user-1',
        }
      : null
  );
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId } as never);
  vi.mocked(moveDay.evaluateMoveDay).mockResolvedValue({
    status: 'ready',
    list: {
      season: 'winter',
      firedAt: '2026-10-14T20:00:00.000Z',
      signal: { tempC: 8, lowC: 2, frostLineC: 5, heatLineC: 32 },
      items: [],
      tenderWithoutWinterHome: [],
    },
  });

  const { evaluateMoveDay } = await import('../../../src/handlers/climate/moveDay.js');
  return { evaluateMoveDay, moveDay, householdService };
}

describe('POST /households/:id/move-day', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns locked for the free tier without evaluating anything', async () => {
    const { evaluateMoveDay, moveDay } = await setup('seedling');
    const res = await evaluateMoveDay(buildEvent(), ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'locked' });
    expect(moveDay.evaluateMoveDay).not.toHaveBeenCalled();
  });

  it.each(['garden', 'greenhouse'] as const)(
    'evaluates for the %s tier as the calling member and returns the result',
    async (planId) => {
      const { evaluateMoveDay, moveDay } = await setup(planId);
      const res = await evaluateMoveDay(buildEvent(), ctx);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'ready', list: { season: 'winter' } });
      expect(moveDay.evaluateMoveDay).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'hh-1' }),
        'user-1'
      );
    }
  );

  it('refuses another household’s id even for an entitled caller', async () => {
    const { evaluateMoveDay, moveDay } = await setup('garden');
    const res = await evaluateMoveDay(buildEvent({ pathParameters: { id: 'hh-2' } }), ctx);
    expect(res.statusCode).toBe(403);
    expect(moveDay.evaluateMoveDay).not.toHaveBeenCalled();
  });

  it('404s when the household row is gone', async () => {
    const { evaluateMoveDay, moveDay } = await setup('garden', false);
    const res = await evaluateMoveDay(buildEvent(), ctx);
    expect(res.statusCode).toBe(404);
    expect(moveDay.evaluateMoveDay).not.toHaveBeenCalled();
  });
});
