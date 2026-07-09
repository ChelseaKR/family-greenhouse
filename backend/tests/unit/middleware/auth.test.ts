import { describe, it, expect, vi, beforeEach } from 'vitest';
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  authMiddleware,
  requireAdmin,
  requireHousehold,
  rejectApiKeyPrincipal,
  __resetMembershipCacheForTests,
} from '../../../src/middleware/auth.js';
import * as householdService from '../../../src/services/householdService.js';

vi.mock('../../../src/services/householdService.js');

function member(householdId: string, userId: string, role: 'admin' | 'member') {
  return {
    householdId,
    userId,
    name: 'Test User',
    email: 'test@example.com',
    role,
    joinedAt: '',
  };
}

function buildEvent(
  claims: Record<string, unknown> | null,
  headers: Record<string, string> = {}
): APIGatewayProxyEvent {
  return {
    body: null,
    headers,
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
  };
}

function makeHandler(stack: middy.MiddlewareObj[]): {
  invoke: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
  inner: ReturnType<typeof vi.fn>;
} {
  const inner = vi.fn(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => ({
    statusCode: 200,
    body: JSON.stringify({ user: (event as unknown as { user?: unknown }).user ?? null }),
  }));
  const composed = middy(inner);
  for (const m of stack) composed.use(m);
  return { invoke: composed as never, inner };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetMembershipCacheForTests();
});

describe('authMiddleware', () => {
  it('attaches claim-derived identity, with household validated against the membership table', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(
      member('hh-1', 'user-1', 'admin')
    );
    const { invoke, inner } = makeHandler([authMiddleware()]);
    const event = buildEvent({
      sub: 'user-1',
      email: 'a@b.com',
      'custom:household_id': 'hh-1',
      'custom:household_role': 'admin',
    });
    const res = await invoke(event);
    expect(res.statusCode).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
    const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
    expect(calledEvent.user).toEqual({
      userId: 'user-1',
      email: 'a@b.com',
      householdId: 'hh-1',
      householdRole: 'admin',
    });
    // The claim alone is never trusted — the membership row was consulted.
    expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-1', 'user-1');
  });

  it('degrades to householdId=null (not a 403) when the claim default is stale (removed member, no explicit override)', async () => {
    // Regression: this used to hard-403 here, at authMiddleware itself, for
    // EVERY authenticated route including GET /me/households and GET
    // /auth/me — leaving a just-removed user with no way to even discover
    // their other households without a full logout/login. The claim is only
    // a hint; a stale hint should fall through to "no active household",
    // not lock the caller out entirely. requireHousehold() is what should
    // 403 resource routes that actually need a household (see below).
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    const { invoke, inner } = makeHandler([authMiddleware()]);
    const event = buildEvent({
      sub: 'user-1',
      email: 'a@b.com',
      'custom:household_id': 'hh-1',
      'custom:household_role': 'admin',
    });
    const res = await invoke(event);
    expect(res.statusCode).toBe(200);
    const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
    expect(calledEvent.user).toEqual({
      userId: 'user-1',
      email: 'a@b.com',
      householdId: null,
      householdRole: null,
    });
  });

  it('requireHousehold still 403s a stale-claim caller on a route that needs a household', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    const { invoke } = makeHandler([authMiddleware(), requireHousehold()]);
    const event = buildEvent({
      sub: 'user-1',
      email: 'a@b.com',
      'custom:household_id': 'hh-1',
      'custom:household_role': 'admin',
    });
    await expect(invoke(event)).rejects.toMatchObject({
      statusCode: 403,
      message: 'User must belong to a household',
    });
  });

  it('takes the role from the membership row, not the claim', async () => {
    // Claim asserts admin; the membership table says member. Table wins.
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(
      member('hh-1', 'user-1', 'member')
    );
    const { invoke, inner } = makeHandler([authMiddleware()]);
    const event = buildEvent({
      sub: 'user-1',
      email: 'a@b.com',
      'custom:household_id': 'hh-1',
      'custom:household_role': 'admin',
    });
    await invoke(event);
    const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
    expect(calledEvent.user.householdRole).toBe('member');
  });

  it('caches the membership lookup (one DDB read per user/household per TTL)', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue(
      member('hh-1', 'user-1', 'member')
    );
    const { invoke } = makeHandler([authMiddleware()]);
    const claims = {
      sub: 'user-1',
      email: 'a@b.com',
      'custom:household_id': 'hh-1',
      'custom:household_role': 'member',
    };
    await invoke(buildEvent(claims));
    await invoke(buildEvent(claims));
    expect(householdService.getMemberByUserId).toHaveBeenCalledTimes(1);
  });

  it('returns null household when claims are absent', async () => {
    const { invoke, inner } = makeHandler([authMiddleware()]);
    const event = buildEvent({ sub: 'user-2', email: 'c@d.com' });
    await invoke(event);
    const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
    expect(calledEvent.user.householdId).toBeNull();
    expect(calledEvent.user.householdRole).toBeNull();
    expect(householdService.getMemberByUserId).not.toHaveBeenCalled();
  });

  it('throws 401 when claims are missing entirely', async () => {
    const { invoke } = makeHandler([authMiddleware()]);
    await expect(invoke(buildEvent(null))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('reads claims from the HTTP API v2 JWT authorizer shape', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(
      member('hh-v2', 'user-v2', 'member')
    );
    const { invoke, inner } = makeHandler([authMiddleware()]);
    // v2 nests claims under `authorizer.jwt.claims` rather than `.claims`.
    const event = buildEvent(null);
    (event.requestContext as { authorizer?: unknown }).authorizer = {
      jwt: {
        claims: {
          sub: 'user-v2',
          email: 'v2@b.com',
          'custom:household_id': 'hh-v2',
          'custom:household_role': 'member',
        },
      },
    };
    const res = await invoke(event);
    expect(res.statusCode).toBe(200);
    const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
    expect(calledEvent.user).toEqual({
      userId: 'user-v2',
      email: 'v2@b.com',
      householdId: 'hh-v2',
      householdRole: 'member',
    });
  });

  describe('X-Household-Id override', () => {
    it('honors the override when the user is a member of the requested household', async () => {
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(
        member('hh-2', 'user-1', 'member')
      );
      const { invoke, inner } = makeHandler([authMiddleware()]);
      const event = buildEvent(
        {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
        { 'x-household-id': 'hh-2' }
      );
      const res = await invoke(event);
      expect(res.statusCode).toBe(200);
      const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
      expect(calledEvent.user.householdId).toBe('hh-2');
      // Role comes from the hh-2 membership row, not the hh-1 claim.
      expect(calledEvent.user.householdRole).toBe('member');
      expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-2', 'user-1');
    });

    it('403s the override when the user is not a member of the requested household', async () => {
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
      const { invoke } = makeHandler([authMiddleware()]);
      const event = buildEvent(
        {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
        { 'x-household-id': 'hh-other' }
      );
      await expect(invoke(event)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('validates the override against the table even when it equals the claim household', async () => {
      // Regression: a pre-check used to skip DDB when header === claim,
      // letting a removed member keep access for the token lifetime.
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
      const { invoke } = makeHandler([authMiddleware()]);
      const event = buildEvent(
        {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
        { 'x-household-id': 'hh-1' }
      );
      await expect(invoke(event)).rejects.toMatchObject({ statusCode: 403 });
      expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-1', 'user-1');
    });
  });
});

describe('requireHousehold', () => {
  it('passes when user has a household', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(
      member('hh', 'u', 'member')
    );
    const { invoke } = makeHandler([authMiddleware(), requireHousehold()]);
    const res = await invoke(
      buildEvent({
        sub: 'u',
        email: 'e',
        'custom:household_id': 'hh',
        'custom:household_role': 'member',
      })
    );
    expect(res.statusCode).toBe(200);
  });

  it('throws 403 when user has no household', async () => {
    const { invoke } = makeHandler([authMiddleware(), requireHousehold()]);
    await expect(invoke(buildEvent({ sub: 'u', email: 'e' }))).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('requireAdmin', () => {
  it('passes when user is admin', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(member('hh', 'u', 'admin'));
    const { invoke } = makeHandler([authMiddleware(), requireAdmin()]);
    const res = await invoke(
      buildEvent({
        sub: 'u',
        email: 'e',
        'custom:household_id': 'hh',
        'custom:household_role': 'admin',
      })
    );
    expect(res.statusCode).toBe(200);
  });

  it('throws 403 when user is a member', async () => {
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(
      member('hh', 'u', 'member')
    );
    const { invoke } = makeHandler([authMiddleware(), requireAdmin()]);
    await expect(
      invoke(
        buildEvent({
          sub: 'u',
          email: 'e',
          'custom:household_id': 'hh',
          'custom:household_role': 'member',
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws 403 when user has no role', async () => {
    const { invoke } = makeHandler([authMiddleware(), requireAdmin()]);
    await expect(invoke(buildEvent({ sub: 'u', email: 'e' }))).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('rejectApiKeyPrincipal (M2)', () => {
  // Middleware that stamps event.user, standing in for authMiddleware /
  // apiKeyMiddleware so we can exercise the guard in isolation.
  const stampUser = (user: Record<string, unknown>): middy.MiddlewareObj => ({
    before: (request) => {
      (request.event as unknown as { user: unknown }).user = user;
    },
  });

  it('403s an API-key principal even though it carries householdRole member', async () => {
    const { invoke } = makeHandler([
      stampUser({
        userId: 'apikey:k1',
        email: '',
        householdId: 'hh',
        householdRole: 'member',
        isApiKey: true,
      }),
      rejectApiKeyPrincipal(),
    ]);
    await expect(invoke(buildEvent({ sub: 'k', email: 'e' }))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('lets a human (non-key) principal through', async () => {
    const { invoke, inner } = makeHandler([
      stampUser({
        userId: 'user-1',
        email: 'a@b.com',
        householdId: 'hh',
        householdRole: 'admin',
      }),
      rejectApiKeyPrincipal(),
    ]);
    const res = await invoke(buildEvent({ sub: 'u', email: 'e' }));
    expect(res.statusCode).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
  });
});
