import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { createHandler } from '../../../src/middleware/handler.js';
import { resolveCorsOrigins } from '../../../src/middleware/cors.js';

const ctx = {} as Context;
const originalAllowedOrigin = process.env.ALLOWED_ORIGIN;

function preflightEvent(origin: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'OPTIONS /{proxy+}',
    rawPath: '/plants',
    rawQueryString: '',
    headers: {
      origin,
      'access-control-request-method': 'PATCH',
      'access-control-request-headers':
        'authorization, content-type, x-household-id, x-cognito-access-token',
    },
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'OPTIONS',
        path: '/plants',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-1',
      routeKey: 'OPTIONS /{proxy+}',
      stage: 'production',
      time: '12/Jul/2026:20:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  };
}

async function invoke(origin: string) {
  const base = vi.fn(async () => ({ statusCode: 500, body: 'should not run' }));
  const handler = createHandler(base);
  const response = (await handler(
    preflightEvent(origin),
    ctx,
    () => undefined
  )) as APIGatewayProxyResultV2;
  return { base, response: response as { statusCode: number; headers: Record<string, string> } };
}

beforeEach(() => {
  process.env.ALLOWED_ORIGIN =
    'https://familygreenhouse.net,capacitor://localhost,https://localhost';
});

afterEach(() => {
  if (originalAllowedOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
  else process.env.ALLOWED_ORIGIN = originalAllowedOrigin;
});

describe('application CORS preflight', () => {
  for (const origin of [
    'https://familygreenhouse.net',
    'capacitor://localhost',
    'https://localhost',
  ]) {
    it(`returns an exact-origin 204 for ${origin}`, async () => {
      const { base, response } = await invoke(origin);

      expect(base).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(204);
      expect(response.headers['Access-Control-Allow-Origin']).toBe(origin);
      expect(response.headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(response.headers['Access-Control-Allow-Methods']).toContain('PATCH');
      expect(response.headers['Access-Control-Allow-Headers']).toContain('X-Household-Id');
      expect(response.headers.Vary).toContain('Origin');
    });
  }

  it('does not authorize an unknown origin', async () => {
    const { base, response } = await invoke('https://attacker.example');

    expect(base).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(204);
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects wildcard configuration instead of reflecting arbitrary origins', () => {
    process.env.ALLOWED_ORIGIN = '*';
    expect(() => resolveCorsOrigins()).toThrow('ALLOWED_ORIGIN wildcards are not permitted');
  });
});
