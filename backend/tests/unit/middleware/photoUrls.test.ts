/**
 * The response-side photo signer that `createHandler` puts on every route
 * (ADR 0033). The rules it applies are tested in
 * tests/unit/services/photoAccess.test.ts; this pins where it applies them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import createHttpError from 'http-errors';
import { createHandler } from '../../../src/middleware/handler.js';
import {
  __resetPhotoSigningClientForTests,
  scopePhotoUrls,
} from '../../../src/services/photoAccess.js';
import { successResponse } from '../../../src/utils/response.js';

const ORIGINAL_ENV = { ...process.env };
const REFERENCE = 'https://app.example/plants/hh-1/p-1/0b7c0a4e-1111-4222-8333-944455556666.jpg';
const context = { awsRequestId: 'test' } as never;

function event(user?: { userId: string; householdId: string | null }) {
  return {
    headers: {},
    requestContext: { identity: { sourceIp: '127.0.0.1' } },
    ...(user ? { user } : {}),
  } as never;
}

const member = () => event({ userId: 'u-1', householdId: 'hh-1' });

beforeEach(() => {
  process.env.IMAGES_BUCKET = 'fixture-images-bucket';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAMIDDLEWARETEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'middleware-secret';
  __resetPhotoSigningClientForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetPhotoSigningClientForTests();
});

const signed = (value: unknown) =>
  typeof value === 'string' && new URL(value).searchParams.has('X-Amz-Signature');

describe('photoUrlSigner, as wired by createHandler', () => {
  it('signs a photo in a member route’s JSON response', async () => {
    const handler = createHandler(async () => successResponse({ imageUrl: REFERENCE }));
    const body = JSON.parse((await handler(member(), context)).body);
    expect(signed(body.imageUrl)).toBe(true);
  });

  it('keeps the other response fields and the status as the handler set them', async () => {
    const handler = createHandler(async () =>
      successResponse({ id: 'p-1', name: 'Monstera', imageUrl: REFERENCE }, 201)
    );
    const response = await handler(member(), context);
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({ id: 'p-1', name: 'Monstera' });
  });

  it('signs nothing on a route that opted out', async () => {
    const handler = createHandler(async () => successResponse({ imageUrl: REFERENCE }), {
      signPhotoUrls: false,
    });
    const body = JSON.parse((await handler(member(), context)).body);
    expect(body.imageUrl).toBe(REFERENCE);
  });

  it('signs nothing for a caller with no household, unless the route declares one', async () => {
    const anonymous = createHandler(async () => successResponse({ imageUrl: REFERENCE }));
    expect(JSON.parse((await anonymous(event(), context)).body).imageUrl).toBe(REFERENCE);

    const notAfter = new Date(Date.now() + 10 * 60 * 1000);
    const publicLink = createHandler(async (e: object) => {
      scopePhotoUrls(e, { householdIds: ['hh-1'], notAfter });
      return successResponse({ imageUrl: REFERENCE });
    });
    const url = new URL(JSON.parse((await publicLink(event(), context)).body).imageUrl);
    const expiresAt =
      Date.parse(
        url.searchParams
          .get('X-Amz-Date')!
          .replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
      ) +
      Number(url.searchParams.get('X-Amz-Expires')) * 1000;
    expect(expiresAt).toBeLessThanOrEqual(notAfter.getTime());
  });

  it('leaves a non-JSON body alone, even one that contains a reference', async () => {
    const handler = createHandler(async () => ({
      statusCode: 200,
      headers: { 'Content-Type': 'text/calendar' },
      body: `URL:${REFERENCE}`,
    }));
    expect((await handler(member(), context)).body).toBe(`URL:${REFERENCE}`);
  });

  it('does not touch an error response', async () => {
    const handler = createHandler(async () => {
      throw createHttpError(400, `bad ${REFERENCE}`);
    });
    const response = await handler(member(), context);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).message).toBe(`bad ${REFERENCE}`);
  });
});
