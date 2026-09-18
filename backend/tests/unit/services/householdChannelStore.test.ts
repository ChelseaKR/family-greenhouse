import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
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

type Sent = { kind: string; input: Record<string, any> };

function conditionalFailure(): Error {
  const err = new Error('conditional');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

const ITEM = {
  PK: 'HOUSEHOLD#hh-1',
  SK: 'CHANNEL#WEBHOOK',
  GSI1PK: 'HOUSEHOLD_CHANNELS',
  GSI1SK: 'HOUSEHOLD#hh-1',
  entityType: 'HouseholdChannel',
  householdId: 'hh-1',
  platform: 'matrix',
  sealedUrl: 'ciphertext',
  urlVersion: 'v1',
  host: 'matrix.example-family.org',
  last4: 'abcd',
  events: { dailyDue: true, upForGrabs: false },
  quietStart: '22:00',
  quietEnd: '07:00',
  timezone: 'Europe/Madrid',
  locale: 'es',
  status: 'active',
  disabledReason: null,
  consecutiveFailures: 0,
  consecutiveClientErrors: 0,
  nextAttemptAt: null,
  lastFailure: null,
  lastDeliveredAt: null,
  lastTestAt: null,
  connectedBy: 'u1',
  connectedAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
  // Something a future change might add to the row. It must never be spread
  // into a record, and so never reach a summary or a response.
  debugPlaintextUrl: 'https://matrix.example-family.org/webhook/secret',
};

async function load() {
  const store = await import('../../../src/services/householdChannelStore.js');
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const send = vi.mocked(dynamodb.send) as unknown as ReturnType<typeof vi.fn>;
  return { store, send };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('householdChannelStore', () => {
  it('reads the channel consistently and builds the record field by field', async () => {
    const { store, send } = await load();
    send.mockResolvedValueOnce({ Item: ITEM });
    const record = await store.getChannel('hh-1');
    const call = send.mock.calls[0][0] as Sent;
    expect(call.input).toMatchObject({
      Key: { PK: 'HOUSEHOLD#hh-1', SK: 'CHANNEL#WEBHOOK' },
      ConsistentRead: true,
    });
    expect(record).toMatchObject({ platform: 'matrix', locale: 'es', timezone: 'Europe/Madrid' });
    expect(JSON.stringify(record)).not.toContain('debugPlaintextUrl');
  });

  it('null means "no channel", and a failed read throws instead of looking like one', async () => {
    const { store, send } = await load();
    send.mockResolvedValueOnce({});
    await expect(store.getChannel('hh-1')).resolves.toBeNull();
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(store.getChannel('hh-1')).rejects.toThrow('throttled');
  });

  it('writes the sparse GSI1 keys so the hourly pass can find it', async () => {
    const { store, send } = await load();
    const record = store.recordFromItem(ITEM)!;
    send.mockResolvedValueOnce({});
    await expect(store.saveChannel(record, null)).resolves.toBe('saved');
    const put = send.mock.calls[0][0] as Sent;
    expect(put.input.Item).toMatchObject({
      GSI1PK: 'HOUSEHOLD_CHANNELS',
      GSI1SK: 'HOUSEHOLD#hh-1',
      entityType: 'HouseholdChannel',
    });
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('an update is optimistic on updatedAt, and a lost race is a conflict', async () => {
    const { store, send } = await load();
    const record = store.recordFromItem(ITEM)!;
    send.mockRejectedValueOnce(conditionalFailure());
    await expect(store.saveChannel(record, '2026-09-01T00:00:00.000Z')).resolves.toBe('conflict');
    const put = send.mock.calls[0][0] as Sent;
    expect(put.input.ConditionExpression).toBe('updatedAt = :expected');
  });

  it('lists every channel across pages', async () => {
    const { store, send } = await load();
    send
      .mockResolvedValueOnce({ Items: [ITEM], LastEvaluatedKey: { PK: 'x' } })
      .mockResolvedValueOnce({ Items: [{ ...ITEM, householdId: 'hh-2' }] });
    const all = await store.listChannels();
    expect(all.map((r) => r.householdId)).toEqual(['hh-1', 'hh-2']);
    expect((send.mock.calls[1][0] as Sent).input.ExclusiveStartKey).toEqual({ PK: 'x' });
    expect((send.mock.calls[0][0] as Sent).input).toMatchObject({
      IndexName: 'GSI1',
      ExpressionAttributeValues: { ':pk': 'HOUSEHOLD_CHANNELS' },
    });
  });

  it('an outcome only lands on the same address it was made with', async () => {
    const { store, send } = await load();
    send.mockResolvedValueOnce({});
    await store.applyOutcome('hh-1', 'v1', { consecutiveFailures: 2, lastFailure: null });
    const update = send.mock.calls[0][0] as Sent;
    expect(update.input.ConditionExpression).toBe(
      'attribute_exists(PK) AND urlVersion = :urlVersion'
    );
    expect(update.input.ExpressionAttributeValues[':urlVersion']).toBe('v1');
    // A disconnected or replaced channel is never resurrected.
    send.mockRejectedValueOnce(conditionalFailure());
    await expect(store.applyOutcome('hh-1', 'v1', { consecutiveFailures: 3 })).resolves.toBe(
      'stale'
    );
  });

  it('reserves a post with a lease that only an expired lease can reclaim', async () => {
    const { store, send } = await load();
    const now = new Date('2026-09-18T12:00:00.000Z');
    send.mockResolvedValueOnce({});
    const id = await store.reservePost('hh-1', 'daily_due', '2026-09-18', now);
    expect(id).toEqual(expect.any(String));
    const put = send.mock.calls[0][0] as Sent;
    expect(put.input.Item).toMatchObject({
      PK: 'HOUSEHOLD#hh-1',
      SK: 'CHANNELPOST#daily_due#2026-09-18',
      status: 'sending',
    });
    expect(put.input.ConditionExpression).toContain('attribute_not_exists(PK)');
    send.mockRejectedValueOnce(conditionalFailure());
    await expect(store.reservePost('hh-1', 'daily_due', '2026-09-18', now)).resolves.toBeNull();
  });

  it('a sent marker, or a live lease, counts as handled; an expired lease does not', async () => {
    const { store, send } = await load();
    const now = new Date('2026-09-18T12:00:00.000Z');
    const epoch = Math.floor(now.getTime() / 1000);
    send.mockResolvedValueOnce({ Item: { status: 'sent' } });
    await expect(store.postAlreadyHandled('hh-1', 'daily_due', 'd', now)).resolves.toBe(true);
    send.mockResolvedValueOnce({ Item: { status: 'sending', leaseExpiresAt: epoch + 60 } });
    await expect(store.postAlreadyHandled('hh-1', 'daily_due', 'd', now)).resolves.toBe(true);
    send.mockResolvedValueOnce({ Item: { status: 'sending', leaseExpiresAt: epoch - 1 } });
    await expect(store.postAlreadyHandled('hh-1', 'daily_due', 'd', now)).resolves.toBe(false);
    send.mockResolvedValueOnce({});
    await expect(store.postAlreadyHandled('hh-1', 'daily_due', 'd', now)).resolves.toBe(false);
  });

  it('finalize and release are conditioned on the reservation', async () => {
    const { store, send } = await load();
    send.mockResolvedValue({});
    await store.finalizePost('hh-1', 'up_for_grabs', '2026-W38', 'r1', new Date());
    await store.releasePost('hh-1', 'up_for_grabs', '2026-W38', 'r1');
    const [finalize, release] = send.mock.calls.map((c) => c[0] as Sent);
    expect(finalize.input.ConditionExpression).toContain('reservationId = :reservationId');
    expect(release.input.ConditionExpression).toBe('reservationId = :reservationId');
    expect(release.input.Key.SK).toBe('CHANNELPOST#up_for_grabs#2026-W38');
  });

  it('delete reports whether there was a channel', async () => {
    const { store, send } = await load();
    send.mockResolvedValueOnce({ Attributes: ITEM });
    await expect(store.deleteChannel('hh-1')).resolves.toBe(true);
    send.mockResolvedValueOnce({});
    await expect(store.deleteChannel('hh-1')).resolves.toBe(false);
  });

  it('refuses to build a record from a row missing its sealed address or platform', async () => {
    const { store } = await load();
    expect(store.recordFromItem({ ...ITEM, sealedUrl: undefined })).toBeNull();
    expect(store.recordFromItem({ ...ITEM, platform: 'teams' })).toBeNull();
  });
});
