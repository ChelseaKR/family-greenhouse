import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type middy from '@middy/core';

// Only `lookupApiKey` is consumed by the middleware. API_SCOPES is inlined
// here (mirrors services/apiKeys.ts) so we don't execute the real service
// module, which would pull in the DDB client.
vi.mock('../../../src/services/apiKeys.js', () => ({
  lookupApiKey: vi.fn(),
}));

// Same reasoning: avoid pulling in the real billing service (DDB + lazy
// Stripe import). Only `getHouseholdSubscription` is consumed here.
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));

// The key's creator has to still be a member; only that one read is consumed.
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(),
}));

import { apiKeyMiddleware, requireApiScope } from '../../../src/middleware/apiKey.js';
import type { ApiKeyEvent } from '../../../src/middleware/apiKey.js';
import * as apiKeys from '../../../src/services/apiKeys.js';
import * as billing from '../../../src/services/billing.js';
import * as householdService from '../../../src/services/householdService.js';
import { __resetMembershipCacheForTests } from '../../../src/utils/membershipCache.js';
import type { AuthenticatedEvent } from '../../../src/middleware/auth.js';

const ALL_SCOPES = ['read:plants', 'read:tasks', 'read:activity'] as const;

function buildEvent(headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers,
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/api/v1/plants',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const keyRecord = {
  id: 'key-1',
  householdId: 'hh-1',
  label: 'Home Assistant',
  last4: 'abcd',
  scopes: [...ALL_SCOPES],
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  lastUsedAt: null,
};

async function runBefore(event: APIGatewayProxyEvent): Promise<void> {
  const mw = apiKeyMiddleware();
  await mw.before!({ event } as middy.Request<APIGatewayProxyEvent>);
}

describe('apiKeyMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMembershipCacheForTests();
    vi.mocked(apiKeys.lookupApiKey).mockResolvedValue(keyRecord);
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'greenhouse' });
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue({
      householdId: 'hh-1',
      userId: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'admin',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('accepts the key via Authorization: Bearer and attaches an isApiKey principal', async () => {
    const event = buildEvent({ authorization: 'Bearer fg_secret123' });
    await runBefore(event);

    expect(apiKeys.lookupApiKey).toHaveBeenCalledWith('fg_secret123');
    const user = (event as AuthenticatedEvent).user;
    expect(user).toEqual({
      userId: 'apikey:key-1',
      email: '',
      householdId: 'hh-1',
      householdRole: 'member',
      isApiKey: true,
    });
    expect((event as ApiKeyEvent).apiScopes).toEqual([...ALL_SCOPES]);
  });

  it('accepts a capitalized Authorization header', async () => {
    const event = buildEvent({ Authorization: 'Bearer fg_secret123' });
    await runBefore(event);
    expect(apiKeys.lookupApiKey).toHaveBeenCalledWith('fg_secret123');
  });

  it('accepts the key via X-Api-Key (both header casings)', async () => {
    for (const headerName of ['x-api-key', 'X-Api-Key']) {
      vi.mocked(apiKeys.lookupApiKey).mockClear();
      const event = buildEvent({ [headerName]: 'fg_alt456' });
      await runBefore(event);
      expect(apiKeys.lookupApiKey).toHaveBeenCalledWith('fg_alt456');
      expect((event as AuthenticatedEvent).user.isApiKey).toBe(true);
    }
  });

  it('trims surrounding whitespace from the presented key', async () => {
    const event = buildEvent({ authorization: 'Bearer fg_secret123   ' });
    await runBefore(event);
    expect(apiKeys.lookupApiKey).toHaveBeenCalledWith('fg_secret123');
  });

  it('throws 401 when no key is presented at all', async () => {
    await expect(runBefore(buildEvent())).rejects.toMatchObject({
      statusCode: 401,
      message: 'API key required',
    });
    expect(apiKeys.lookupApiKey).not.toHaveBeenCalled();
  });

  it('throws 401 for a non-Bearer Authorization header with no X-Api-Key fallback', async () => {
    await expect(
      runBefore(buildEvent({ authorization: 'Basic dXNlcjpwYXNz' }))
    ).rejects.toMatchObject({ statusCode: 401, message: 'API key required' });
  });

  it('throws 401 when the key is unknown or revoked (lookup returns null)', async () => {
    vi.mocked(apiKeys.lookupApiKey).mockResolvedValue(null);
    const event = buildEvent({ authorization: 'Bearer fg_revoked' });
    await expect(runBefore(event)).rejects.toMatchObject({
      statusCode: 401,
      message: 'Invalid API key',
    });
    expect((event as Partial<AuthenticatedEvent>).user).toBeUndefined();
  });

  it.each(['garden', 'seedling'] as const)(
    "throws 403 when the key's household has downgraded to %s",
    async (planId) => {
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId });
      const event = buildEvent({ authorization: 'Bearer fg_secret123' });
      await expect(runBefore(event)).rejects.toMatchObject({
        statusCode: 403,
        message:
          'API access requires the Greenhouse plan. This household has downgraded — upgrade to keep using this key.',
      });
      expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-1');
      expect((event as Partial<AuthenticatedEvent>).user).toBeUndefined();
    }
  );

  // #449: the plan is re-checked on every use; the CREATOR'S MEMBERSHIP was
  // not. An admin who minted a key, moved out, and was removed kept full
  // household read access and task write access through /api/v1/* forever.
  it("throws 403 when the key's creator is no longer a member of the household", async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue(null);
    const event = buildEvent({ authorization: 'Bearer fg_secret123' });
    await expect(runBefore(event)).rejects.toMatchObject({
      statusCode: 403,
      message:
        'This API key was issued by someone who is no longer a member of the household. Ask an admin to issue a new one.',
    });
    expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-1', 'user-1');
    expect((event as Partial<AuthenticatedEvent>).user).toBeUndefined();
  });

  it('also refuses a key whose creator was anonymized by account deletion', async () => {
    // anonymizeUserInHousehold rewrites createdBy to the deleted-user id, which
    // is never a member row — so the same check covers a deleted account.
    vi.mocked(apiKeys.lookupApiKey).mockResolvedValue({
      ...keyRecord,
      createdBy: 'deleted-user',
    });
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue(null);
    const event = buildEvent({ authorization: 'Bearer fg_secret123' });
    await expect(runBefore(event)).rejects.toMatchObject({ statusCode: 403 });
    expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-1', 'deleted-user');
  });

  it('reads the membership only once per warm container, then serves from cache', async () => {
    const first = buildEvent({ authorization: 'Bearer fg_secret123' });
    const second = buildEvent({ authorization: 'Bearer fg_secret123' });
    await runBefore(first);
    await runBefore(second);
    expect(householdService.getMemberByUserId).toHaveBeenCalledTimes(1);
    expect((second as Partial<AuthenticatedEvent>).user?.householdId).toBe('hh-1');
  });

  it('passes through and attaches the principal when the household is still on greenhouse', async () => {
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'greenhouse' });
    const event = buildEvent({ authorization: 'Bearer fg_secret123' });
    await runBefore(event);

    expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-1');
    const user = (event as AuthenticatedEvent).user;
    expect(user).toEqual({
      userId: 'apikey:key-1',
      email: '',
      householdId: 'hh-1',
      householdRole: 'member',
      isApiKey: true,
    });
  });
});

describe('requireApiScope', () => {
  async function runScope(
    scope: 'read:plants' | 'read:tasks' | 'read:activity',
    scopes?: string[]
  ): Promise<void> {
    const event = buildEvent() as ApiKeyEvent;
    if (scopes) event.apiScopes = scopes as ApiKeyEvent['apiScopes'];
    const mw = requireApiScope(scope);
    await mw.before!({ event } as middy.Request<APIGatewayProxyEvent>);
  }

  it('passes when the key carries the required scope', async () => {
    await expect(runScope('read:plants', ['read:plants'])).resolves.toBeUndefined();
  });

  it('throws a 403 naming the missing scope', async () => {
    await expect(runScope('read:tasks', ['read:plants'])).rejects.toMatchObject({
      statusCode: 403,
      message: 'This API key is missing the required scope: read:tasks',
    });
  });

  it('throws 403 when apiScopes was never populated (middleware misordering)', async () => {
    await expect(runScope('read:plants', undefined)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('a legacy all-read key (service default) passes every scope gate', async () => {
    // services/apiKeys.ts mapRecord expands pre-scope rows to all read scopes;
    // a key carrying that expansion must clear each per-route gate.
    for (const scope of ALL_SCOPES) {
      await expect(runScope(scope, [...ALL_SCOPES])).resolves.toBeUndefined();
    }
  });
});
