import { describe, it, expect } from 'vitest';
import createHttpError from 'http-errors';
import { z } from 'zod';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { createHandler, createRawBodyHandler } from '../../../src/middleware/handler.js';
import { validateBody } from '../../../src/middleware/validation.js';

/**
 * Error-body contract tests (see middleware/handler.ts jsonErrorHandler):
 * every error response is JSON `{ message: string, details?: unknown }`
 * with `Content-Type: application/json`.
 */

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

const ctx = {} as Context;

async function invoke(
  handler: unknown,
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  return (await (handler as (e: unknown, c: Context, cb: () => void) => Promise<unknown>)(
    event,
    ctx,
    () => {}
  )) as APIGatewayProxyResult;
}

describe('jsonErrorHandler (middleware/handler.ts)', () => {
  it('exposes 4xx messages as JSON {message}', async () => {
    const handler = createHandler(async () => {
      throw createHttpError(404, 'Plant not found');
    });
    const res = await invoke(handler, buildEvent());
    expect(res.statusCode).toBe(404);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ message: 'Plant not found' });
  });

  it('masks unexpected 5xx (plain Error) behind a generic JSON message', async () => {
    const handler = createHandler(async () => {
      throw new Error('connection string postgres://user:hunter2@db');
    });
    const res = await invoke(handler, buildEvent());
    expect(res.statusCode).toBe(500);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ message: 'Internal Server Error' });
    expect(res.body).not.toContain('hunter2');
  });

  it('masks 5xx http-errors thrown WITHOUT expose', async () => {
    const handler = createHandler(async () => {
      throw createHttpError(502, 'internal upstream detail');
    });
    const res = await invoke(handler, buildEvent());
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ message: 'Internal Server Error' });
  });

  it('honors expose:true on intentional 502s (keeps status AND message)', async () => {
    const handler = createHandler(async () => {
      throw createHttpError(502, 'Stripe checkout failed. Please try again shortly.', {
        expose: true,
      });
    });
    const res = await invoke(handler, buildEvent());
    expect(res.statusCode).toBe(502);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({
      message: 'Stripe checkout failed. Please try again shortly.',
    });
  });

  it('surfaces Zod validation details from validateBody as JSON {message, details}', async () => {
    const schema = z.object({ email: z.string().email(), age: z.number().int().min(0) });
    const handler = createHandler(async () => ({ statusCode: 200, headers: {}, body: '{}' })).use(
      validateBody(schema)
    );
    const res = await invoke(
      handler,
      buildEvent({
        body: JSON.stringify({ email: 'nope', age: -3 }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Validation failed');
    expect(body.details).toMatchObject({
      email: expect.any(Array),
      age: expect.any(Array),
    });
  });

  it('returns 400 "Invalid JSON body" for malformed JSON reaching validateBody', async () => {
    const schema = z.object({ name: z.string() });
    const handler = createHandler(async () => ({ statusCode: 200, headers: {}, body: '{}' })).use(
      validateBody(schema)
    );
    // No content-type header → middy's body parser skips it and validateBody
    // does the bare JSON.parse that used to throw an unhandled SyntaxError.
    const res = await invoke(handler, buildEvent({ body: '{"name": "unterminated' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ message: 'Invalid JSON body' });
  });

  it('createRawBodyHandler (Stripe webhook path) uses the same JSON error shape and leaves the raw body alone', async () => {
    let seenBody: unknown = null;
    const handler = createRawBodyHandler(async (event: APIGatewayProxyEvent) => {
      seenBody = event.body;
      throw createHttpError(400, 'Webhook signature failed: bad sig');
    });
    const raw = '{"id": "evt_1",   "object": "event"}';
    const res = await invoke(
      handler,
      buildEvent({ body: raw, headers: { 'content-type': 'application/json' } })
    );
    // Raw string body reached the handler unparsed (signature verification
    // depends on the exact bytes).
    expect(seenBody).toBe(raw);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ message: 'Webhook signature failed: bad sig' });
  });

  it('successful responses pass through untouched', async () => {
    const handler = createHandler(async () => ({
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }));
    const res = await invoke(handler, buildEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
