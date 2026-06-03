import { describe, it, expect, vi } from 'vitest';
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { authMiddleware, requireAdmin, requireHousehold } from '../../../src/middleware/auth.js';

function buildEvent(claims: Record<string, unknown> | null): APIGatewayProxyEvent {
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
  };
}

function makeHandler(stack: middy.MiddlewareObj[]): {
  invoke: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
  inner: ReturnType<typeof vi.fn>;
} {
  const inner = vi.fn(
    async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => ({
      statusCode: 200,
      body: JSON.stringify({ user: (event as unknown as { user?: unknown }).user ?? null }),
    })
  );
  const composed = middy(inner);
  for (const m of stack) composed.use(m);
  return { invoke: composed as never, inner };
}

describe('authMiddleware', () => {
  it('attaches Cognito claims onto event.user', async () => {
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
  });

  it('returns null household when claims are absent', async () => {
    const { invoke, inner } = makeHandler([authMiddleware()]);
    const event = buildEvent({ sub: 'user-2', email: 'c@d.com' });
    await invoke(event);
    const calledEvent = inner.mock.calls[0][0] as { user: Record<string, unknown> };
    expect(calledEvent.user.householdId).toBeNull();
    expect(calledEvent.user.householdRole).toBeNull();
  });

  it('throws 401 when claims are missing entirely', async () => {
    const { invoke } = makeHandler([authMiddleware()]);
    await expect(invoke(buildEvent(null))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('reads claims from the HTTP API v2 JWT authorizer shape', async () => {
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
});

describe('requireHousehold', () => {
  it('passes when user has a household', async () => {
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
