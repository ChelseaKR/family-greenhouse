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

function storedRow(endpoint: string, sk = expectedSk(endpoint), createdAt?: string) {
  return {
    PK: 'USER#u1',
    SK: sk,
    ...sub(endpoint),
    ...(createdAt ? { createdAt } : {}),
  };
}

describe('pushSubscriptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys subscriptions by truncated SHA-256 of the endpoint', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    await saveSubscription(sub(endpoint));
    const cmd = vi.mocked(dynamodb.send).mock.calls.at(-1)![0] as unknown as {
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

    await saveSubscription(sub('https://fcm.googleapis.com/fcm/send/device-a'));
    await saveSubscription(sub('https://fcm.googleapis.com/fcm/send/device-b'));
    const [first, second] = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Item?: { SK: string } } })
      .filter((command) => command.kind === 'Put')
      .map((command) => command.input.Item!.SK);
    expect(first).not.toBe(second);
  });

  it('deleteSubscription addresses the canonical SHA key when no row exists', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteSubscription } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [] } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ Items: [] } as never);

    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    await expect(deleteSubscription('u1', endpoint)).resolves.toBe(0);
    const cmd = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      kind: string;
      input: { Key: { PK: string; SK: string } };
    };
    expect(cmd.kind).toBe('Delete');
    expect(cmd.input.Key).toEqual({ PK: 'USER#u1', SK: expectedSk(endpoint) });
  });

  it('remainingSubscriptions is a real count, not one saturated at the delivery cap', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteSubscription } = await import('../../../src/services/pushSubscriptions.js');

    const revoked = 'https://fcm.googleapis.com/fcm/send/device-to-revoke';
    // A partition that predates (or has drifted past) the 20-endpoint write
    // guard. The delivery read slices to 20 on purpose; its LENGTH must not
    // then be published to the client as "how many subscriptions remain".
    const survivors = Array.from(
      { length: 22 },
      (_, i) => `https://fcm.googleapis.com/fcm/send/device-${i}`
    );

    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [storedRow(revoked), ...survivors.map((e) => storedRow(e))],
      } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({
        Items: survivors.map((e) => storedRow(e)),
      } as never);

    await expect(deleteSubscription('u1', revoked)).resolves.toBe(22);
  });

  it('rejects arbitrary, cleartext, and private push endpoints before persistence', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');

    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/no-tls',
      'https://127.0.0.1/internal',
      'https://169.254.169.254/latest/meta-data',
      'https://push.attacker.example/slow',
      'https://wns.windows.com.attacker.example/w/fake',
      'https://notify.windows.com.attacker.example/w/fake',
    ]) {
      await expect(saveSubscription(sub(endpoint))).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('accepts browser-issued endpoints across Chrome, Firefox, Safari, and Edge', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/chrome',
      'https://updates.push.services.mozilla.com/wpush/v2/firefox',
      'https://web.push.apple.com/QP/safari',
      'https://wns2-am3p.notify.windows.com/w/?token=edge',
      'https://edge.wns.windows.com/w/?token=edge-new',
    ]) {
      await expect(saveSubscription(sub(endpoint))).resolves.toBeUndefined();
    }

    const puts = vi
      .mocked(dynamodb.send)
      .mock.calls.filter(([command]) => (command as unknown as { kind: string }).kind === 'Put');
    expect(puts).toHaveLength(5);
  });

  it('caps stored endpoints per user while allowing refresh of an existing endpoint', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');
    const stored = Array.from({ length: 20 }, (_, index) =>
      storedRow(`https://fcm.googleapis.com/fcm/send/device-${index}`)
    );
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: stored } as never);

    await expect(
      saveSubscription(sub('https://fcm.googleapis.com/fcm/send/device-over-cap'))
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      vi
        .mocked(dynamodb.send)
        .mock.calls.filter(([command]) => (command as unknown as { kind: string }).kind === 'Put')
    ).toHaveLength(0);

    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: stored } as never)
      .mockResolvedValueOnce({} as never);
    await expect(saveSubscription(stored[0])).resolves.toBeUndefined();
    expect(
      vi
        .mocked(dynamodb.send)
        .mock.calls.filter(([command]) => (command as unknown as { kind: string }).kind === 'Put')
    ).toHaveLength(1);
  });

  it('migrates a legacy duplicate after the canonical write succeeds', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { saveSubscription } = await import('../../../src/services/pushSubscriptions.js');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/legacy-device';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [storedRow(endpoint, 'PUSH#old32hash')] } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);

    await saveSubscription(sub(endpoint));

    const commands = vi.mocked(dynamodb.send).mock.calls.map(
      ([command]) =>
        command as unknown as {
          kind: string;
          input: { Item?: { SK: string }; Key?: { PK: string; SK: string } };
        }
    );
    expect(commands.map((command) => command.kind)).toEqual(['Query', 'Put', 'Delete']);
    expect(commands[1].input.Item?.SK).toBe(expectedSk(endpoint));
    expect(commands[2].input.Key).toEqual({ PK: 'USER#u1', SK: 'PUSH#old32hash' });
  });

  it('unsubscribe deletes canonical and every matching legacy row but preserves a colliding endpoint', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteSubscription } = await import('../../../src/services/pushSubscriptions.js');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-to-revoke';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          storedRow(endpoint, 'PUSH#old32hash'),
          storedRow(endpoint),
          storedRow('https://fcm.googleapis.com/fcm/send/colliding-device', 'PUSH#collision'),
        ],
      } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({
        Items: [
          storedRow('https://fcm.googleapis.com/fcm/send/colliding-device', 'PUSH#collision'),
        ],
      } as never);

    await expect(deleteSubscription('u1', endpoint)).resolves.toBe(1);

    const deleted = vi
      .mocked(dynamodb.send)
      .mock.calls.map(
        ([command]) => command as unknown as { kind: string; input: { Key?: unknown } }
      )
      .filter((command) => command.kind === 'Delete')
      .map((command) => command.input.Key);
    expect(deleted).toEqual(
      expect.arrayContaining([
        { PK: 'USER#u1', SK: expectedSk(endpoint) },
        { PK: 'USER#u1', SK: 'PUSH#old32hash' },
      ])
    );
    expect(deleted).not.toContainEqual({ PK: 'USER#u1', SK: 'PUSH#collision' });
  });

  it('deduplicates migrated rows by endpoint and keeps the newest credentials', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getUserSubscriptions } = await import('../../../src/services/pushSubscriptions.js');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device';
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        {
          ...storedRow(endpoint, 'PUSH#old32hash', '2026-01-01T00:00:00.000Z'),
          keys: { p256dh: 'old', auth: 'old' },
        },
        {
          ...storedRow(endpoint, expectedSk(endpoint), '2026-06-01T00:00:00.000Z'),
          keys: { p256dh: 'new', auth: 'new' },
        },
      ],
    } as never);

    await expect(getUserSubscriptions('u1')).resolves.toEqual([
      expect.objectContaining({ endpoint, keys: { p256dh: 'new', auth: 'new' } }),
    ]);
  });

  it('deletes every subscription page during account cleanup', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteUserSubscriptions } = await import('../../../src/services/pushSubscriptions.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          { PK: 'USER#u1', SK: 'PUSH#one' },
          { PK: 'USER#u1', SK: 'PUSH#two' },
        ],
        LastEvaluatedKey: { PK: 'USER#u1', SK: 'PUSH#two' },
      } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({
        Items: [{ PK: 'USER#u1', SK: 'PUSH#three' }],
      } as never)
      .mockResolvedValueOnce({} as never);

    await deleteUserSubscriptions('u1');

    const commands = vi.mocked(dynamodb.send).mock.calls.map(
      ([command]) =>
        command as unknown as {
          kind: string;
          input: {
            ExclusiveStartKey?: Record<string, string>;
            Key?: Record<string, string>;
            ProjectionExpression?: string;
          };
        }
    );
    const queries = commands.filter((command) => command.kind === 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[0].input.ProjectionExpression).toBe('PK, SK');
    expect(queries[1].input.ExclusiveStartKey).toEqual({
      PK: 'USER#u1',
      SK: 'PUSH#two',
    });
    expect(
      commands.filter((command) => command.kind === 'Delete').map((command) => command.input.Key)
    ).toEqual([
      { PK: 'USER#u1', SK: 'PUSH#one' },
      { PK: 'USER#u1', SK: 'PUSH#two' },
      { PK: 'USER#u1', SK: 'PUSH#three' },
    ]);
  });
});
