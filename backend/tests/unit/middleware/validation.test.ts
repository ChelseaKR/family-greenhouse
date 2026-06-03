import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { validateBody, ValidatedEvent } from '../../../src/middleware/validation.js';

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const bodySchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0),
});

describe('validateBody', () => {
  it('parses a string body and stores validatedBody', async () => {
    const inner = vi.fn(
      async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => ({
        statusCode: 200,
        body: JSON.stringify((event as ValidatedEvent<unknown>).validatedBody),
      })
    );
    const handler = middy(inner).use(validateBody(bodySchema));
    const res = await (handler as never)(
      buildEvent({ body: JSON.stringify({ email: 'a@b.com', age: 30 }) })
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ email: 'a@b.com', age: 30 });
  });

  it('returns 400 with field details when invalid', async () => {
    const handler = middy(async () => ({ statusCode: 200, body: '' })).use(
      validateBody(bodySchema)
    );
    await expect(
      (handler as never)(buildEvent({ body: JSON.stringify({ email: 'nope', age: -1 }) }))
    ).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({
        email: expect.any(Array),
        age: expect.any(Array),
      }),
    });
  });
});

// validatePathParams / validateQueryParams were deleted on 2026-06-01: never
// imported by any production handler. If we revive Zod-based path/query
// validation, restore the tests alongside the middleware.
