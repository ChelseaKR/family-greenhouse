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
