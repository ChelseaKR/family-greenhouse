/**
 * POST /households/{id}/upgrade-requests through the real middy stack: the
 * household guard, the admin refusal, the payments gate, body validation,
 * and the mapping of every service refusal to its status code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/upgradeRequests.js', () => ({
  requestUpgrade: vi.fn(),
}));
vi.mock('../../../src/services/householdService.js');

const ctx = {} as Context;

const memberClaims = {
  sub: 'u-sam',
  email: 'sam@example.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'member',
};

function buildEvent(
  claims: Record<string, unknown> | null,
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ feature: 'chat' }),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/upgrade-requests',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: null,
    requestContext: {
      authorizer: claims ? { claims } : undefined,
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/households/{id}/upgrade-requests',
    stageVariables: null,
    ...overrides,
  };
}

const RESULT = {
  feature: 'chat',
  targetPlanId: 'garden',
  requestedAt: '2026-09-03T10:00:00.000Z',
  nextAllowedAt: '2026-09-10T10:00:00.000Z',
  admins: [{ userId: 'u-admin', name: 'Maria' }],
  emailDelivered: true,
  pushDelivered: false,
};

async function invoke(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { createUpgradeRequest } =
    await import('../../../src/handlers/households/upgradeRequests.js');
  return (await createUpgradeRequest(event, ctx, () => {})) as APIGatewayProxyResult;
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
  process.env.ALLOWED_ORIGIN = 'https://test.familygreenhouse.net';
  process.env.PAYMENTS_ENABLED = '1';
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('u-sam', 'hh-1', 'member');
  setCachedMembership('u-admin', 'hh-1', 'admin');
  const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
  vi.mocked(upgradeRequests.requestUpgrade).mockResolvedValue(RESULT as never);
});

describe('POST /households/{id}/upgrade-requests', () => {
  it('201s for a member, passing the feature and the app URL to the service', async () => {
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    const res = await invoke(buildEvent(memberClaims));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual(RESULT);
    expect(upgradeRequests.requestUpgrade).toHaveBeenCalledWith({
      householdId: 'hh-1',
      requester: { userId: 'u-sam', email: 'sam@example.com' },
      feature: 'chat',
      appUrl: 'https://test.familygreenhouse.net',
    });
  });

  it('401s without claims', async () => {
    const res = await invoke(buildEvent(null));
    expect(res.statusCode).toBe(401);
  });

  it('403s when the path names a household the caller is not acting in', async () => {
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    const res = await invoke(buildEvent(memberClaims, { pathParameters: { id: 'hh-other' } }));
    expect(res.statusCode).toBe(403);
    expect(upgradeRequests.requestUpgrade).not.toHaveBeenCalled();
  });

  it('409s for an admin — they can change the plan themselves', async () => {
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    const res = await invoke(
      buildEvent({ ...memberClaims, sub: 'u-admin', email: 'maria@example.com' })
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/admin of this household/);
    expect(upgradeRequests.requestUpgrade).not.toHaveBeenCalled();
  });

  it('503s while payment activity is paused, before touching the service', async () => {
    delete process.env.PAYMENTS_ENABLED;
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    const res = await invoke(buildEvent(memberClaims));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).message).toBe('Payments are currently paused.');
    expect(upgradeRequests.requestUpgrade).not.toHaveBeenCalled();
  });

  it('400s an unknown feature id — the vocabulary is closed', async () => {
    const res = await invoke(
      buildEvent(memberClaims, { body: JSON.stringify({ feature: 'free text here' }) })
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).details).toHaveProperty('feature');
  });

  it('maps the weekly limit to 429 and carries nextAllowedAt in details', async () => {
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    vi.mocked(upgradeRequests.requestUpgrade).mockRejectedValueOnce(
      Object.assign(new Error('You already asked for this recently.'), {
        name: 'UpgradeRequestRateLimitedError',
        nextAllowedAt: '2026-09-10T10:00:00.000Z',
      })
    );
    const res = await invoke(buildEvent(memberClaims));
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({
      message: 'You already asked for this recently.',
      details: { nextAllowedAt: '2026-09-10T10:00:00.000Z' },
    });
  });

  it('maps "already included" and "no admin" to 409', async () => {
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    for (const name of ['UpgradeAlreadyIncludedError', 'NoHouseholdAdminError']) {
      vi.mocked(upgradeRequests.requestUpgrade).mockRejectedValueOnce(
        Object.assign(new Error(`${name} message`), { name })
      );
      const res = await invoke(buildEvent(memberClaims));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe(`${name} message`);
    }
  });

  it('500s (opaque) on an unexpected service failure', async () => {
    const upgradeRequests = await import('../../../src/services/upgradeRequests.js');
    vi.mocked(upgradeRequests.requestUpgrade).mockRejectedValueOnce(new Error('ddb exploded'));
    const res = await invoke(buildEvent(memberClaims));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('ddb exploded');
  });
});
