import { describe, expect, it } from 'vitest';
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { bodySizeGuard } from '../../../src/middleware/bodySize.js';

function buildEvent(body: string | null, isBase64Encoded = false): APIGatewayProxyEvent {
  return {
    body,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const handler = middy(
  async (): Promise<APIGatewayProxyResult> => ({ statusCode: 200, body: 'ok' })
).use(bodySizeGuard(64));

describe('bodySizeGuard', () => {
  it('passes a body under the limit', async () => {
    const res = await (handler as never)(buildEvent('hello'));
    expect(res.statusCode).toBe(200);
  });

  it('rejects a body over the limit with 413', async () => {
    const big = 'x'.repeat(128);
    await expect((handler as never)(buildEvent(big))).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it('passes a null body', async () => {
    const res = await (handler as never)(buildEvent(null));
    expect(res.statusCode).toBe(200);
  });

  it('decodes base64-encoded length', async () => {
    // 100 base64 chars ≈ 75 bytes, over the 64-byte cap.
    const base64Body = 'A'.repeat(100);
    await expect((handler as never)(buildEvent(base64Body, true))).rejects.toMatchObject({
      statusCode: 413,
    });
  });
});
