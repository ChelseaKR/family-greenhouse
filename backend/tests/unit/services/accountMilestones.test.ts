import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
}));

vi.mock('../../../src/utils/dynamodb', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

function conditionalFailure(): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

describe('accountMilestones.claimFirstPlant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims the row once and answers first when the household now has one active plant', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { claimFirstPlant } = await import('../../../src/services/accountMilestones');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ Item: { plantCount: 1 } } as never);

    expect(await claimFirstPlant('user-1', 'hh-1')).toBe('first');

    const [put, get] = vi.mocked(dynamodb.send).mock.calls.map(
      ([c]) =>
        c as never as {
          kind: string;
          input: Record<string, unknown>;
        }
    );
    expect(put.kind).toBe('Put');
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(PK)');
    // The row holds a timestamp and nothing else: no plant, name or household.
    expect(put.input.Item).toEqual({
      PK: 'USER#user-1',
      SK: 'MILESTONE#FIRST_PLANT',
      entityType: 'AccountMilestone',
      reachedAt: expect.any(String),
    });
    expect(get.kind).toBe('Get');
    expect(get.input.Key).toEqual({ PK: 'HOUSEHOLD#hh-1', SK: 'METADATA' });
  });

  it('answers not_first, with one write and no read, once the account has claimed it', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { claimFirstPlant } = await import('../../../src/services/accountMilestones');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionalFailure());

    expect(await claimFirstPlant('user-1', 'hh-1')).toBe('not_first');
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
  });

  it('claims but answers not_first when the household already had plants (an account from before the row existed)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { claimFirstPlant } = await import('../../../src/services/accountMilestones');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ Item: { plantCount: 4 } } as never);

    expect(await claimFirstPlant('user-1', 'hh-1')).toBe('not_first');
    // The claim was really written, so the next plant cannot count either.
    expect(vi.mocked(dynamodb.send).mock.calls[0]?.[0]).toMatchObject({ kind: 'Put' });
  });

  it('answers unknown, never false and never a throw, when DynamoDB fails', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { claimFirstPlant } = await import('../../../src/services/accountMilestones');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('DDB down'));
    await expect(claimFirstPlant('user-1', 'hh-1')).resolves.toBe('unknown');

    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('DDB down'));
    await expect(claimFirstPlant('user-1', 'hh-1')).resolves.toBe('unknown');
  });
});
