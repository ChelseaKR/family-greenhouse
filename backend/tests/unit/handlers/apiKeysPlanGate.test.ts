/**
 * POST /api-keys — the plan gate on MINTING a key.
 *
 * #476: `middleware/apiKey.ts` already refuses to serve a request on a key
 * whose household is no longer entitled (`getEntitledPlan(sub).id !==
 * 'greenhouse'`), but minting compared `sub.planId` directly. A household
 * mid-dunning could therefore issue a key that its own very next request
 * would be refused with — the two halves of one feature disagreeing about
 * whether it is entitled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/apiKeys.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/apiKeys.js')>(
    '../../../src/services/apiKeys.js'
  );
  return { ...actual, createApiKey: vi.fn() };
});
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));

import * as apiKeysService from '../../../src/services/apiKeys.js';
import * as billing from '../../../src/services/billing.js';

type Subscription = Awaited<ReturnType<typeof billing.getHouseholdSubscription>>;
const subscription = (over: Record<string, unknown>) => over as unknown as Subscription;

const CREATED = {
  key: 'fg_plaintext',
  record: { id: 'key-1', label: 'CI', last4: 'text', scopes: [] },
} as unknown as Awaited<ReturnType<typeof apiKeysService.createApiKey>>;

function buildEvent(): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ label: 'CI' }),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/api-keys',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: { sub: 'user-1', email: 'a@b.com', 'custom:household_id': 'hh-1' },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const ctx = {} as Context;

async function subject() {
  return (await import('../../../src/handlers/apiKeys/handler.js')).createKey;
}

describe('POST /api-keys plan gate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    __resetMembershipCacheForTests();
    // Minting is admin-only on top of the plan gate.
    setCachedMembership('user-1', 'hh-1', 'admin');
    vi.mocked(apiKeysService.createApiKey).mockResolvedValue(CREATED);
  });

  it('mints for a Greenhouse household in good standing', async () => {
    const createKey = await subject();
    for (const status of ['active', 'trialing', undefined]) {
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
        subscription({ planId: 'greenhouse', ...(status ? { status } : {}) })
      );
      const res = (await createKey(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(201);
    }
    expect(apiKeysService.createApiKey).toHaveBeenCalledTimes(3);
  });

  it('refuses to mint while the card has failed, even though planId is still greenhouse (#476)', async () => {
    const createKey = await subject();
    for (const status of ['past_due', 'unpaid', 'incomplete', 'canceled', 'paused']) {
      vi.mocked(apiKeysService.createApiKey).mockClear();
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
        subscription({ planId: 'greenhouse', status })
      );
      const res = (await createKey(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(402);
      // No key is issued — the point is that the key would be dead on arrival:
      // middleware/apiKey.ts already refuses to serve requests on it.
      expect(apiKeysService.createApiKey).not.toHaveBeenCalled();
    }
  });

  it('still mints for a lifetime Greenhouse owner whose later subscription was cancelled', async () => {
    // The entitlement FLOOR: a one-time purchase has no refund path and no
    // subscription status may fall below it.
    const createKey = await subject();
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
      subscription({ planId: 'seedling', status: 'canceled', lifetimePlanId: 'greenhouse' })
    );
    const res = (await createKey(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    expect(apiKeysService.createApiKey).toHaveBeenCalledWith('hh-1', 'user-1', 'CI', undefined);
  });

  it('still refuses a Garden household', async () => {
    const createKey = await subject();
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
      subscription({ planId: 'garden', status: 'active' })
    );
    const res = (await createKey(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(402);
    expect(apiKeysService.createApiKey).not.toHaveBeenCalled();
  });
});
