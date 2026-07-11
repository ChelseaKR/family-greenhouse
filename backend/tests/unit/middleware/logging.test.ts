import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type middy from '@middy/core';

/**
 * loggingMiddleware wiring (OBS-12 — trace correlation, plus the
 * request/response record contract).
 *
 * `withRequest` is faked so the child logger's calls can be inspected;
 * `currentTraceId` stays REAL — the point of the correlation tests is
 * that the actual X-Ray parse feeds the child logger's context, so a
 * CloudWatch line can be pivoted to the X-Ray trace. The serialization
 * of that context into JSON is pinned separately in
 * tests/unit/utils/logger.test.ts.
 */

const recorded = vi.hoisted(() => ({
  contexts: [] as Record<string, unknown>[],
  logs: [] as { level: string; fields: Record<string, unknown>; msg: string }[],
}));

function makeFakeLog(level: 'info' | 'error') {
  return (fields: Record<string, unknown>, msg: string) =>
    void recorded.logs.push({ level, fields, msg });
}

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import('../../../src/utils/logger.js');
  return {
    ...mod,
    logger: { info: makeFakeLog('info'), error: makeFakeLog('error') },
    withRequest: vi.fn((ctx: Record<string, unknown>) => {
      recorded.contexts.push(ctx);
      return { info: makeFakeLog('info'), error: makeFakeLog('error') };
    }),
  };
});

import { loggingMiddleware, LoggedEvent } from '../../../src/middleware/logging.js';
import { withRequest } from '../../../src/utils/logger.js';
import type { AuthenticatedEvent } from '../../../src/middleware/auth.js';

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/plants',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: { requestId: 'rid-ctx' } as APIGatewayProxyEvent['requestContext'],
    resource: '/plants',
    ...overrides,
  };
}

type Request = middy.Request<APIGatewayProxyEvent, APIGatewayProxyResult>;

function buildRequest(event: APIGatewayProxyEvent): Request {
  return { event, context: {}, response: null, error: null, internal: {} } as unknown as Request;
}

async function runHook(
  hook: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> | undefined,
  request: Request
) {
  await hook?.(request);
}

beforeEach(() => {
  recorded.contexts.length = 0;
  recorded.logs.length = 0;
  vi.mocked(withRequest).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trace correlation (OBS-12)', () => {
  it('binds the parsed X-Ray root id into the request-scoped logger', async () => {
    vi.stubEnv(
      '_X_AMZN_TRACE_ID',
      'Root=1-6817f3a2-abcdef012345;Parent=53995c3f42cd8ad8;Sampled=1'
    );
    const request = buildRequest(buildEvent());
    await runHook(loggingMiddleware().before, request);

    expect(recorded.contexts).toEqual([
      { requestId: 'rid-ctx', traceId: '1-6817f3a2-abcdef012345' },
    ]);
  });

  it('omits traceId outside Lambda instead of logging a bogus value', async () => {
    vi.stubEnv('_X_AMZN_TRACE_ID', '');
    const request = buildRequest(buildEvent());
    await runHook(loggingMiddleware().before, request);

    expect(recorded.contexts[0].traceId).toBeUndefined();
  });
});

describe('request-scoped logger wiring', () => {
  it('prefers the API Gateway requestId, falling back to the x-request-id header', async () => {
    const viaContext = buildRequest(buildEvent());
    await runHook(loggingMiddleware().before, viaContext);
    expect(recorded.contexts[0].requestId).toBe('rid-ctx');

    const viaHeader = buildRequest(
      buildEvent({
        headers: { 'x-request-id': 'rid-header' },
        requestContext: {} as APIGatewayProxyEvent['requestContext'],
      })
    );
    await runHook(loggingMiddleware().before, viaHeader);
    expect(recorded.contexts[1].requestId).toBe('rid-header');
  });

  it('attaches the child logger to the event for downstream handlers', async () => {
    const request = buildRequest(buildEvent());
    await runHook(loggingMiddleware().before, request);
    expect((request.event as LoggedEvent).log).toBeDefined();
  });

  it('logs a "request" record with method and path (REST/v1 shape)', async () => {
    const request = buildRequest(buildEvent());
    await runHook(loggingMiddleware().before, request);

    expect(recorded.logs).toEqual([
      { level: 'info', fields: { method: 'GET', path: '/plants', msg: 'request' }, msg: 'request' },
    ]);
  });

  it('logs method and path from requestContext.http (HTTP API v2 shape)', async () => {
    const request = buildRequest(
      buildEvent({
        httpMethod: undefined as unknown as string,
        path: undefined as unknown as string,
        requestContext: {
          requestId: 'rid-v2',
          http: { method: 'POST', path: '/tasks' },
        } as unknown as APIGatewayProxyEvent['requestContext'],
      })
    );
    await runHook(loggingMiddleware().before, request);

    expect(recorded.logs[0].fields).toMatchObject({ method: 'POST', path: '/tasks' });
  });
});

describe('response and error records', () => {
  it('resolves userId/householdId lazily — auth runs after before(), so identity must come from the after() hook', async () => {
    const mw = loggingMiddleware();
    const request = buildRequest(buildEvent());
    await runHook(mw.before, request);

    // Simulate authMiddleware running between the hooks.
    (request.event as AuthenticatedEvent).user = {
      userId: 'user-1',
      householdId: 'hh-1',
    } as AuthenticatedEvent['user'];
    request.response = { statusCode: 201 } as APIGatewayProxyResult;
    await runHook(mw.after, request);

    const response = recorded.logs.at(-1)!;
    expect(response.msg).toBe('response');
    expect(response.fields).toMatchObject({ status: 201, userId: 'user-1', householdId: 'hh-1' });
  });

  it('logs handler errors with the error object and identity', async () => {
    const mw = loggingMiddleware();
    const request = buildRequest(buildEvent());
    await runHook(mw.before, request);

    (request.event as AuthenticatedEvent).user = {
      userId: 'user-2',
      householdId: 'hh-2',
    } as AuthenticatedEvent['user'];
    request.error = new Error('kaput');
    await runHook(mw.onError, request);

    const errorRecord = recorded.logs.at(-1)!;
    expect(errorRecord.level).toBe('error');
    expect(errorRecord.msg).toBe('handler_error');
    expect(errorRecord.fields).toMatchObject({ userId: 'user-2', householdId: 'hh-2' });
    expect((errorRecord.fields.err as Error).message).toBe('kaput');
  });

  it('falls back to the root logger when before() never ran', async () => {
    const mw = loggingMiddleware();
    const request = buildRequest(buildEvent());
    request.response = { statusCode: 500 } as APIGatewayProxyResult;
    await runHook(mw.after, request);

    // No withRequest child exists, yet the record still lands.
    expect(recorded.contexts).toHaveLength(0);
    expect(recorded.logs.at(-1)).toMatchObject({ msg: 'response' });
  });
});
