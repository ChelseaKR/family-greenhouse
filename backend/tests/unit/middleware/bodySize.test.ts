import { describe, expect, it } from 'vitest';
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { bodySizeGuard, IMAGE_BODY_MAX_BYTES } from '../../../src/middleware/bodySize.js';

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

const handler = middy(async (): Promise<APIGatewayProxyResult> => ({
  statusCode: 200,
  body: 'ok',
})).use(bodySizeGuard(64));

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

  it("IMAGE_BODY_MAX_BYTES comfortably fits the image-upload schemas' own 350,000-char cap plus JSON envelope overhead", () => {
    // Guards against the exact bug this override fixes: identify.ts/health.ts
    // allow imageBase64 up to 350,000 characters, wrapped in a small JSON
    // envelope — this override must stay bigger than that combined size, or
    // in-spec uploads get a 413 before their own schema ever runs.
    const wrappedBodyBytes = JSON.stringify({ imageBase64: 'A'.repeat(350_000) }).length;
    expect(IMAGE_BODY_MAX_BYTES).toBeGreaterThan(wrappedBodyBytes);
  });
});
