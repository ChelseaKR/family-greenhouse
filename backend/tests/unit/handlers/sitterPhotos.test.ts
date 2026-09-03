/**
 * Unit tests for the PUBLIC (auth=none) sitter photo-back handlers
 * (handlers/tasks/sitterPhotos.ts). These run the real middy stack with NO
 * Cognito authorizer on the event, and — unlike the task-view tests — use
 * the REAL sitterService over a mocked DynamoDB client, so the "refused
 * after expiresAt" and "refused when revoked" cases exercise the actual
 * window check, not a mock of it.
 *
 * Storage (S3, the photo row, the activity event) is mocked so the tests
 * pin the ORDER of refusals: nothing is written until every check passed,
 * and a failure after the quota reservation gives the slot back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/s3.js', () => ({
  s3: { send: vi.fn() },
  IMAGES_BUCKET: 'images-bucket',
  publicImageUrl: (key: string) => `https://assets.example/${key}`,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: vi.fn(function (input) {
    return { input, kind: 'PutObject' };
  }),
  DeleteObjectCommand: vi.fn(function (input) {
    return { input, kind: 'DeleteObject' };
  }),
}));
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));

const ctx = {} as Context;
const TOKEN = 'a'.repeat(64);
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

/** A 64-byte JPEG-magic payload, base64. */
const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]).toString(
  'base64'
);
const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56),
]).toString('base64');

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: `SITTER#${TOKEN}`,
    SK: 'METADATA',
    entityType: 'SitterLink',
    id: 'link-1',
    token: TOKEN,
    householdId: 'hh-1',
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00.000Z',
    startsAt: '2026-01-01T00:00:00.000Z',
    expiresAt: FUTURE,
    status: 'active',
    label: 'Our plants',
    ...overrides,
  };
}

type Sent = { input: Record<string, unknown>; kind: string };

/** Wire the mocked DynamoDB: GetItem answers with `row` (or nothing);
 *  UpdateItem (the quota ADD) answers with the given count or fails the
 *  condition. Returns the recorded commands for assertions. */
async function wireDynamo(opts: {
  row?: Record<string, unknown> | null;
  photoCountAfter?: number;
  capReached?: boolean;
}) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const sent = cmd as Sent;
    if (sent.kind === 'Get') {
      return opts.row === null ? {} : { Item: opts.row ?? linkRow() };
    }
    if (sent.kind === 'Update') {
      const expr = String(sent.input.UpdateExpression);
      if (expr.includes(':one')) {
        if (opts.capReached) {
          throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        }
        return { Attributes: { photoCount: opts.photoCountAfter ?? 1 } };
      }
      return {};
    }
    return {};
  });
  return dynamodb;
}

function anonEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: `/sitter/${TOKEN}/photos`,
    pathParameters: { token: TOKEN },
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: ip },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

function uploadEvent(body: Record<string, unknown>, ip?: string): APIGatewayProxyEvent {
  return anonEvent({ body: JSON.stringify(body) }, ip);
}

async function wireStorage() {
  const taskService = await import('../../../src/services/taskService.js');
  const plantService = await import('../../../src/services/plantService.js');
  const { s3 } = await import('../../../src/utils/s3.js');
  vi.mocked(taskService.getTask).mockResolvedValue({
    id: 'task-1',
    householdId: 'hh-1',
    plantId: 'plant-1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
  } as never);
  vi.mocked(plantService.getPlant).mockResolvedValue({
    id: 'plant-1',
    householdId: 'hh-1',
    name: 'Monstera',
  } as never);
  vi.mocked(plantService.appendPlantPhoto).mockResolvedValue({
    id: 'photo-1',
    plantId: 'plant-1',
    imageUrl: 'https://assets.example/plants/hh-1/plant-1/x.jpg',
    uploadedBy: 'sitter:link-1',
    uploadedAt: '2026-08-12T09:00:00.000Z',
    caption: null,
    viaSitter: true,
    sitterLinkId: 'link-1',
  } as never);
  vi.mocked(s3.send).mockResolvedValue({} as never);
  return { taskService, plantService, s3 };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  const { __resetSitterPhotoLimiterForTests } =
    await import('../../../src/services/sitterPhotoPolicy.js');
  __resetSitterPhotoLimiterForTests();
  const billing = await import('../../../src/services/billing.js');
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);
});

describe('POST /sitter/{token}/photos (public)', () => {
  it('stores an in-spec photo under the household prefix, marks it viaSitter, and emits the activity event', async () => {
    await wireDynamo({ photoCountAfter: 3 });
    const { plantService, s3 } = await wireStorage();
    const { recordActivity } = await import('../../../src/services/activity.js');
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const res = (await uploadSitterPhoto(
      uploadEvent({
        taskId: 'task-1',
        image: `data:image/jpeg;base64,${JPEG_B64}`,
        caption: ' Perky ',
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      photoId: 'photo-1',
      plantName: 'Monstera',
      caption: 'Perky',
      used: 3,
      remaining: 57,
    });
    // PII-free: no household id, no plant id, no stored URL (its key path
    // carries both), no link internals.
    expect(body.imageUrl).toBeUndefined();
    expect(res.body).not.toContain('hh-1');
    expect(res.body).not.toContain('plant-1');
    expect(res.body).not.toContain('createdBy');

    // S3 object under the EXISTING per-plant prefix with the sitter marker.
    const put = vi.mocked(s3.send).mock.calls[0][0] as unknown as Sent;
    expect(put.kind).toBe('PutObject');
    expect(String(put.input.Key)).toMatch(/^plants\/hh-1\/plant-1\/[0-9a-f-]{36}\.jpg$/);
    expect(put.input.ContentType).toBe('image/jpeg');
    expect(put.input.Metadata).toEqual({ 'via-sitter': 'true', 'sitter-link-id': 'link-1' });

    // Timeline-only append attributed to the link; never the primary image.
    expect(plantService.appendPlantPhoto).toHaveBeenCalledWith(
      'hh-1',
      'plant-1',
      expect.stringMatching(/^https:\/\/assets\.example\/plants\/hh-1\/plant-1\//),
      'sitter:link-1',
      'Perky',
      { viaSitter: { linkId: 'link-1' }, setPrimaryImage: false }
    );

    // The existing photo.uploaded event, with viaSitter + the link id.
    expect(recordActivity).toHaveBeenCalledWith({
      type: 'photo.uploaded',
      householdId: 'hh-1',
      actorId: 'sitter:link-1',
      actorName: 'a plant sitter',
      payload: {
        plantId: 'plant-1',
        photoId: 'photo-1',
        plantName: 'Monstera',
        imageUrl: expect.stringMatching(/^https:\/\/assets\.example\//),
        caption: 'Perky',
        viaSitter: true,
        sitterLinkId: 'link-1',
      },
    });
  });

  it('refuses after the link’s expiresAt — real window check, nothing stored', async () => {
    const dynamodb = await wireDynamo({ row: linkRow({ expiresAt: PAST }) });
    const { s3 } = await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: JPEG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toBe('This sitter link is invalid or has expired.');
    expect(s3.send).not.toHaveBeenCalled();
    // Only the GetItem ran — no quota ADD, no row write.
    const kinds = vi.mocked(dynamodb.send).mock.calls.map((c) => (c[0] as unknown as Sent).kind);
    expect(kinds).toEqual(['Get']);
  });

  it('refuses a revoked link and a missing token with the same generic 404', async () => {
    const { s3 } = await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    await wireDynamo({ row: linkRow({ status: 'revoked' }) });
    const revoked = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: JPEG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(revoked.statusCode).toBe(404);

    await wireDynamo({ row: null });
    const missing = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: JPEG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).message).toBe(JSON.parse(revoked.body).message);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('402s (and stores nothing) when the household’s plan lacks the Away Kit', async () => {
    await wireDynamo({});
    const { s3 } = await wireStorage();
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' } as never);
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: JPEG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(402);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('404s a task that is not in the token’s household (scoped read) without touching storage', async () => {
    const dynamodb = await wireDynamo({});
    const { taskService, s3 } = await wireStorage();
    vi.mocked(taskService.getTask).mockResolvedValue(null as never);
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'someone-elses-task', image: JPEG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    expect(taskService.getTask).toHaveBeenCalledWith('hh-1', 'someone-elses-task');
    expect(s3.send).not.toHaveBeenCalled();
    const kinds = vi.mocked(dynamodb.send).mock.calls.map((c) => (c[0] as unknown as Sent).kind);
    expect(kinds).not.toContain('Update');
  });

  it('400s bytes that are not an image even with an image data-URL header — magic bytes, not the header', async () => {
    await wireDynamo({});
    const { s3 } = await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    const html = Buffer.from('<!doctype html><html><body>not a plant</body></html>'.padEnd(80));

    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: `data:image/jpeg;base64,${html.toString('base64')}` }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toBe('Photo is not a JPEG, PNG, or WebP image');
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('413s a photo over 300 KB decoded, and refuses an even larger body before parsing', async () => {
    await wireDynamo({});
    const { s3 } = await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const over = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(300 * 1024),
    ]);
    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: over.toString('base64') }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    // The zod max on the text catches it first (a readable 400) or the byte
    // check (413) — either way nothing is stored.
    expect([400, 413]).toContain(res.statusCode);
    expect(s3.send).not.toHaveBeenCalled();

    const huge = Buffer.alloc(600 * 1024, 0x41);
    const guarded = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: huge.toString('base64') }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(guarded.statusCode).toBe(413);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('409s when the link already holds 60 photos — the cap is one conditional ADD, and nothing is stored', async () => {
    await wireDynamo({ capReached: true });
    const { s3, plantService } = await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: PNG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toContain('60-photo limit');
    expect(s3.send).not.toHaveBeenCalled();
    expect(plantService.appendPlantPhoto).not.toHaveBeenCalled();
  });

  it('gives the slot back and discards the object when the photo row write fails', async () => {
    const dynamodb = await wireDynamo({ photoCountAfter: 5 });
    const { s3, plantService } = await wireStorage();
    vi.mocked(plantService.appendPlantPhoto).mockRejectedValueOnce(new Error('ddb down'));
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');

    const res = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: PNG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(500);
    const s3Kinds = vi.mocked(s3.send).mock.calls.map((c) => (c[0] as unknown as Sent).kind);
    expect(s3Kinds).toEqual(['PutObject', 'DeleteObject']);
    const updates = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as Sent)
      .filter((c) => c.kind === 'Update')
      .map((c) => String(c.input.UpdateExpression));
    expect(updates).toEqual(['ADD photoCount :one', 'ADD photoCount :minusOne']);
  });

  it('applies a per-token brake (429 after 10 uploads/min from any IP)', async () => {
    await wireDynamo({});
    await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    for (let i = 0; i < 10; i++) {
      const r = (await uploadSitterPhoto(
        uploadEvent({ taskId: 'task-1', image: PNG_B64 }, `198.51.100.${i + 1}`),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(r.statusCode).toBe(201);
    }
    const limited = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: PNG_B64 }, '198.51.100.200'),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(limited.statusCode).toBe(429);
  });

  it('applies an IP rate limit (429 after 20 requests/min) before any other work', async () => {
    await wireDynamo({ row: null });
    const { s3 } = await wireStorage();
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    const ip = '203.0.113.77';
    for (let i = 0; i < 20; i++) {
      const r = (await uploadSitterPhoto(
        uploadEvent({ taskId: 'task-1', image: PNG_B64 }, ip),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(r.statusCode).toBe(404);
    }
    const limited = (await uploadSitterPhoto(
      uploadEvent({ taskId: 'task-1', image: PNG_B64 }, ip),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(limited.statusCode).toBe(429);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('400s a body that fails the schema (missing taskId) without touching the link row', async () => {
    const dynamodb = await wireDynamo({});
    const { uploadSitterPhoto } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    const res = (await uploadSitterPhoto(
      uploadEvent({ image: PNG_B64 }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(dynamodb.send).not.toHaveBeenCalled();
  });
});

describe('GET /sitter/{token}/photos (public)', () => {
  it('reports enabled + remaining for an Away Kit household', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
      const sent = cmd as Sent;
      if (sent.kind === 'Get' && sent.input.ProjectionExpression === 'photoCount') {
        return { Item: { photoCount: 12 } };
      }
      return { Item: linkRow() };
    });
    const { getSitterPhotoStatus } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    const res = (await getSitterPhotoStatus(
      anonEvent({ httpMethod: 'GET' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ enabled: true, max: 60, used: 12, remaining: 48 });
  });

  it('reports enabled: false with null counts (never "0 used") when the plan lacks the Away Kit', async () => {
    await wireDynamo({});
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' } as never);
    const { getSitterPhotoStatus } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    const res = (await getSitterPhotoStatus(
      anonEvent({ httpMethod: 'GET' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ enabled: false, max: 60, used: null, remaining: null });
  });

  it('404s an expired link', async () => {
    await wireDynamo({ row: linkRow({ expiresAt: PAST }) });
    const { getSitterPhotoStatus } = await import('../../../src/handlers/tasks/sitterPhotos.js');
    const res = (await getSitterPhotoStatus(
      anonEvent({ httpMethod: 'GET' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });
});

describe('route table', () => {
  it('is spread into the tasks group router', async () => {
    const { handler } = await import('../../../src/handlers/tasks/handler.js');
    expect(handler.routes).toContain('GET /sitter/{token}/photos');
    expect(handler.routes).toContain('POST /sitter/{token}/photos');
  });
});
