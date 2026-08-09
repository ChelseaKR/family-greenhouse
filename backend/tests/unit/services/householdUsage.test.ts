import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import { getHouseholdCounters } from '../../../src/services/householdUsage.js';
import { dynamodb } from '../../../src/utils/dynamodb.js';
import { logger } from '../../../src/utils/logger.js';

describe('getHouseholdCounters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves genuine zero and positive counts', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { plantCount: 0, memberCount: 3 },
    } as never);

    await expect(getHouseholdCounters('hh-1')).resolves.toEqual({
      plantCount: 0,
      memberCount: 3,
    });
    expect(logger.warn).not.toHaveBeenCalled();

    const command = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { TableName: string; Key: { PK: string; SK: string } };
    };
    expect(command).toMatchObject({
      kind: 'Get',
      input: {
        TableName: 'test-table',
        Key: { PK: 'HOUSEHOLD#hh-1', SK: 'METADATA' },
      },
    });
  });

  it('returns null for each missing counter and logs the unseeded state', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { plantCount: 7 },
    } as never);

    await expect(getHouseholdCounters('legacy-hh')).resolves.toEqual({
      plantCount: 7,
      memberCount: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { householdId: 'legacy-hh', unavailableCounters: ['memberCount'] },
      'household_counters_unseeded'
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('treats a %s stored counter as unavailable', async (_label, value) => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { plantCount: value, memberCount: 1 },
    } as never);

    await expect(getHouseholdCounters('invalid-hh')).resolves.toEqual({
      plantCount: null,
      memberCount: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { householdId: 'invalid-hh', unavailableCounters: ['plantCount'] },
      'household_counters_unseeded'
    );
  });

  it('returns unknown counters and a distinct log event when the read fails', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('DynamoDB unavailable') as never);

    await expect(getHouseholdCounters('hh-2')).resolves.toEqual({
      plantCount: null,
      memberCount: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { err: 'DynamoDB unavailable', householdId: 'hh-2' },
      'household_counters_read_failed'
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'household_counters_unseeded');
  });
});
