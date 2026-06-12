import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  QueryCommand: vi.fn((input) => ({ input, kind: 'Query' })),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

describe('activity service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('recordActivity writes an ActivityEvent row', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { recordActivity } = await import('../../../src/services/activity.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);

    await recordActivity({
      type: 'plant.created',
      householdId: 'hh',
      actorId: 'u1',
      actorName: 'A',
      payload: { plantId: 'p1' },
    });

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(cmd.input.Item.PK).toBe('HOUSEHOLD#hh#ACTIVITY');
    expect(cmd.input.Item.entityType).toBe('ActivityEvent');
    expect(cmd.input.Item.type).toBe('plant.created');
  });

  it('recordActivity is genuinely best-effort: a DDB failure resolves instead of rejecting', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { recordActivity } = await import('../../../src/services/activity.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));

    // The docstring always promised best-effort; now a failure here can't
    // turn the caller's already-committed main write into a 500.
    await expect(
      recordActivity({
        type: 'member.joined',
        householdId: 'hh',
        actorId: 'u1',
        actorName: 'A',
        payload: {},
      })
    ).resolves.toBeUndefined();
  });
});
