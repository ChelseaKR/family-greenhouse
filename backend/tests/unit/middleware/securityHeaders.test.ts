import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../../src/middleware/handler.js';

const ctx = {} as Context;
const event = {
  headers: {},
  body: null,
  httpMethod: 'GET',
  requestContext: {},
} as unknown as APIGatewayProxyEvent;

function invoke(h: ReturnType<typeof createHandler>): Promise<APIGatewayProxyResult> {
  return (h as unknown as (e: APIGatewayProxyEvent, c: Context) => Promise<APIGatewayProxyResult>)(
    event,
    ctx
  );
}

describe('securityHeaders', () => {
  it('stamps security headers on a successful response', async () => {
    const ok = createHandler(() =>
      Promise.resolve({ statusCode: 200, body: 'ok' } as APIGatewayProxyResult)
    );
    const res = await invoke(ok);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
    expect(String(res.headers?.['Strict-Transport-Security'])).toContain('max-age=');
    expect(res.headers?.['Content-Security-Policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
  });

  it('stamps security headers on an error response too', async () => {
    const boom = createHandler(() => {
      throw createHttpError(400, 'nope');
    });
    const res = await invoke(boom);
    expect(res.statusCode).toBe(400);
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers?.['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });
});
