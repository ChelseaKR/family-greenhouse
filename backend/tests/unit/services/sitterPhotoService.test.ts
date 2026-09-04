/**
 * Sitter photo-back I/O: the atomic per-link quota on the SITTER# row, and
 * the S3 write under the household's existing photo prefix.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: vi.fn(function (input) {
    return { input, kind: 'PutObject' };
  }),
  DeleteObjectCommand: vi.fn(function (input) {
    return { input, kind: 'DeleteObject' };
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

const TOKEN = 'f'.repeat(64);

type Sent = { input: Record<string, unknown>; kind: string };

describe('reserveSitterPhotoSlot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes one slot with a single conditional ADD (no read-then-write window)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { reserveSitterPhotoSlot } = await import('../../../src/services/sitterPhotoService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { photoCount: 7 } } as never);

    const result = await reserveSitterPhotoSlot(TOKEN);

    expect(result).toEqual({ ok: true, used: 7 });
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as Sent;
    expect(cmd.kind).toBe('Update');
    expect(cmd.input.Key).toEqual({ PK: `SITTER#${TOKEN}`, SK: 'METADATA' });
    expect(cmd.input.UpdateExpression).toBe('ADD photoCount :one');
    expect(cmd.input.ConditionExpression).toContain('photoCount < :max');
    expect(cmd.input.ConditionExpression).toContain('attribute_exists(PK)');
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ':one': 1, ':max': 60 });
  });

  it('reports cap_reached when the condition fails, and rethrows anything else', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { reserveSitterPhotoSlot } = await import('../../../src/services/sitterPhotoService.js');
    const full = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
    vi.mocked(dynamodb.send).mockRejectedValueOnce(full as never);
    expect(await reserveSitterPhotoSlot(TOKEN)).toEqual({ ok: false, reason: 'cap_reached' });

    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
    await expect(reserveSitterPhotoSlot(TOKEN)).rejects.toThrow('throttled');
  });
});

describe('releaseSitterPhotoSlot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('decrements, never below zero, and swallows failures (a leaked slot only tightens the cap)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { releaseSitterPhotoSlot } = await import('../../../src/services/sitterPhotoService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    await releaseSitterPhotoSlot(TOKEN);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as Sent;
    expect(cmd.input.UpdateExpression).toBe('ADD photoCount :minusOne');
    expect(cmd.input.ConditionExpression).toContain('photoCount > :zero');

    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('boom') as never);
    await expect(releaseSitterPhotoSlot(TOKEN)).resolves.toBeUndefined();
  });
});

describe('getSitterPhotoCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the stored count, 0 for a link with no uploads yet, and null when the row is gone', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getSitterPhotoCount } = await import('../../../src/services/sitterPhotoService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { photoCount: 12 } } as never);
    expect(await getSitterPhotoCount(TOKEN)).toBe(12);
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: {} } as never);
    expect(await getSitterPhotoCount(TOKEN)).toBe(0);
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    expect(await getSitterPhotoCount(TOKEN)).toBeNull();
  });
});

describe('storeSitterPhoto', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes under the household’s existing per-plant prefix with via-sitter metadata', async () => {
    const { s3 } = await import('../../../src/utils/s3.js');
    const { storeSitterPhoto } = await import('../../../src/services/sitterPhotoService.js');
    vi.mocked(s3.send).mockResolvedValueOnce({} as never);

    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const stored = await storeSitterPhoto({
      householdId: 'hh-1',
      plantId: 'plant-1',
      linkId: 'link-1',
      bytes,
      contentType: 'image/jpeg',
    });

    expect(stored.key).toMatch(/^plants\/hh-1\/plant-1\/[0-9a-f-]{36}\.jpg$/);
    expect(stored.imageUrl).toBe(`https://assets.example/${stored.key}`);
    const cmd = vi.mocked(s3.send).mock.calls[0][0] as unknown as Sent;
    expect(cmd.kind).toBe('PutObject');
    expect(cmd.input.Bucket).toBe('images-bucket');
    expect(cmd.input.ContentType).toBe('image/jpeg');
    expect(cmd.input.ContentLength).toBe(bytes.length);
    expect(cmd.input.Metadata).toEqual({ 'via-sitter': 'true', 'sitter-link-id': 'link-1' });
  });

  it('discardSitterPhoto deletes the object and never throws', async () => {
    const { s3 } = await import('../../../src/utils/s3.js');
    const { discardSitterPhoto } = await import('../../../src/services/sitterPhotoService.js');
    vi.mocked(s3.send).mockResolvedValueOnce({} as never);
    await discardSitterPhoto('plants/hh-1/plant-1/x.jpg');
    const cmd = vi.mocked(s3.send).mock.calls[0][0] as unknown as Sent;
    expect(cmd.kind).toBe('DeleteObject');
    expect(cmd.input.Key).toBe('plants/hh-1/plant-1/x.jpg');

    vi.mocked(s3.send).mockRejectedValueOnce(new Error('nope') as never);
    await expect(discardSitterPhoto('plants/hh-1/plant-1/y.jpg')).resolves.toBeUndefined();
  });
});
