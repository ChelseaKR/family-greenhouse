import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
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

describe('native device-token delivery read', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps the fan-out at the NEWEST 20 devices and says that it did', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // 25 rows, oldest first, so a cap applied before the sort would keep
    // exactly the tokens a rotating device has already abandoned.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: Array.from({ length: 25 }, (_, index) => ({
        userId: 'u1',
        householdId: 'h1',
        platform: 'android',
        token: `tok-${String(index).padStart(2, '0')}`,
        createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      })),
    } as never);
    const { logger } = await import('../../../src/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn');

    const { getUserDeviceTokens } = await import('../../../src/services/deviceTokens.js');
    const tokens = await getUserDeviceTokens('u1');

    expect(tokens).toHaveLength(20);
    expect(tokens[0].token).toBe('tok-24');
    expect(tokens.at(-1)?.token).toBe('tok-05');
    expect(
      warn.mock.calls.filter(
        ([fields]) => (fields as { msg?: string }).msg === 'device_tokens_capped'
      )
    ).toHaveLength(1);
    warn.mockRestore();
  });

  it('skips a row with no token rather than sending to `undefined`', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [{ userId: 'u1', householdId: 'h1', platform: 'ios' }],
    } as never);

    const { getUserDeviceTokens } = await import('../../../src/services/deviceTokens.js');
    await expect(getUserDeviceTokens('u1')).resolves.toEqual([]);
  });
});

describe('native device-token registration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes one row per device, keyed by the hashed token', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const { saveDeviceToken } = await import('../../../src/services/deviceTokens.js');
    await saveDeviceToken({
      userId: 'u1',
      householdId: 'h1',
      platform: 'ios',
      token: 'tok-a',
      createdAt: '2026-09-01T00:00:00Z',
    });

    const { createHash } = await import('node:crypto');
    const command = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { Item: Record<string, unknown> };
    };
    expect(command.kind).toBe('Put');
    expect(command.input.Item.SK).toBe(
      `DEVICE#${createHash('sha256').update('tok-a').digest('hex').slice(0, 16)}`
    );
    expect(command.input.Item.entityType).toBe('DeviceToken');
  });
});

describe('native device-token deletion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('follows pagination and deletes every token key', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [{ PK: 'USER#u1', SK: 'DEVICE#a' }],
        LastEvaluatedKey: { PK: 'USER#u1', SK: 'DEVICE#a' },
      } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ Items: [{ PK: 'USER#u1', SK: 'DEVICE#b' }] } as never)
      .mockResolvedValueOnce({} as never);

    const { deleteUserDeviceTokens } = await import('../../../src/services/deviceTokens.js');
    await deleteUserDeviceTokens('u1');

    const commands = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => call[0] as unknown as { kind: string; input: Record<string, any> });
    expect(commands.filter((command) => command.kind === 'Query')).toHaveLength(2);
    expect(
      commands.filter((command) => command.kind === 'Delete').map((command) => command.input.Key)
    ).toEqual([
      { PK: 'USER#u1', SK: 'DEVICE#a' },
      { PK: 'USER#u1', SK: 'DEVICE#b' },
    ]);
  });
});
