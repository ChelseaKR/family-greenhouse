import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

const sub = (endpoint: string) => ({
  userId: 'u1',
  householdId: 'hh',
  endpoint,
  keys: { p256dh: 'k', auth: 'a' },
  createdAt: '2026-06-01T00:00:00.000Z',
});

function expectedSk(endpoint: string): string {
  return `PUSH#${createHash('sha256').update(endpoint).digest('hex').slice(0, 16)}`;
}

describe('pushSubscriptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys subscriptions by truncated SHA-256 of the endpoint', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const endpoint = 'https://push.example.com/send/abc123';
    await saveSubscription(sub(endpoint));
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: { PK: string; SK: string } };
    };
    expect(cmd.input.Item.PK).toBe('USER#u1');
    expect(cmd.input.Item.SK).toBe(expectedSk(endpoint));
    expect(cmd.input.Item.SK).toMatch(/^PUSH#[0-9a-f]{16}$/);
  });

  it('distinct endpoints get distinct SKs (the old 32-bit hash could collide)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    await saveSubscription(sub('https://push.example.com/send/device-a'));
    await saveSubscription(sub('https://push.example.com/send/device-b'));
    const [first, second] = vi
      .mocked(dynamodb.send)
      .mock.calls.map(
        (c) => (c[0] as unknown as { input: { Item: { SK: string } } }).input.Item.SK
      );
    expect(first).not.toBe(second);
  });

  it('deleteSubscription addresses the same SHA-based key', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteSubscription } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const endpoint = 'https://push.example.com/send/abc123';
    await deleteSubscription('u1', endpoint);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { Key: { PK: string; SK: string } };
    };
    expect(cmd.kind).toBe('Delete');
    expect(cmd.input.Key).toEqual({ PK: 'USER#u1', SK: expectedSk(endpoint) });
  });
});
