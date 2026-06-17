import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (i) {
    return { input: i, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (i) {
    return { input: i, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';

describe('identifyBudget service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IDENTIFY_METERING_ENABLED;
  });

  afterEach(() => {
    delete process.env.IDENTIFY_METERING_ENABLED;
  });

  it('exposes the per-plan monthly allowances (seedling 3 / garden 30 / greenhouse 100)', async () => {
    const { allowanceForPlan, IDENTIFY_ALLOWANCES } =
      await import('../../../src/services/identifyBudget.js');
    expect(IDENTIFY_ALLOWANCES).toEqual({ seedling: 3, garden: 30, greenhouse: 100 });
    expect(allowanceForPlan('seedling')).toBe(3);
    expect(allowanceForPlan('garden')).toBe(30);
    expect(allowanceForPlan('greenhouse')).toBe(100);
  });

  it('meteringEnabled is OFF unless IDENTIFY_METERING_ENABLED=1 (beta default)', async () => {
    const { meteringEnabled } = await import('../../../src/services/identifyBudget.js');
    expect(meteringEnabled()).toBe(false);
    process.env.IDENTIFY_METERING_ENABLED = '0';
    expect(meteringEnabled()).toBe(false);
    process.env.IDENTIFY_METERING_ENABLED = 'true'; // strict: only '1' enables
    expect(meteringEnabled()).toBe(false);
    process.env.IDENTIFY_METERING_ENABLED = '1';
    expect(meteringEnabled()).toBe(true);
  });

  it('incrementUsage atomically ADDs to the household month row and returns the new total', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { used: 4 } } as never);
    const { incrementUsage } = await import('../../../src/services/identifyBudget.js');
    const used = await incrementUsage('hh-1', new Date('2026-06-11T12:00:00Z'));
    expect(used).toBe(4);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: {
        Key: { PK: string; SK: string };
        UpdateExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(cmd.kind).toBe('Update');
    expect(cmd.input.Key).toEqual({ PK: 'IDENTIFY#BUDGET', SK: 'MONTH#2026-06#HH#hh-1' });
    expect(cmd.input.UpdateExpression).toContain('ADD #used :one');
    expect(cmd.input.ExpressionAttributeValues[':one']).toBe(1);
  });

  it('rolls over to a fresh row each calendar month (UTC)', async () => {
    vi.mocked(dynamodb.send).mockResolvedValue({ Attributes: { used: 1 } } as never);
    const { incrementUsage } = await import('../../../src/services/identifyBudget.js');
    await incrementUsage('hh-1', new Date('2026-06-30T23:59:59Z'));
    await incrementUsage('hh-1', new Date('2026-07-01T00:00:01Z'));
    const keys = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => (c[0] as unknown as { input: { Key: { SK: string } } }).input.Key.SK);
    expect(keys).toEqual(['MONTH#2026-06#HH#hh-1', 'MONTH#2026-07#HH#hh-1']);
  });

  it('getUsage reads the month row, defaulting to 0 when absent', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined } as never);
    const { getUsage } = await import('../../../src/services/identifyBudget.js');
    expect(await getUsage('hh-1', new Date('2026-06-11T00:00:00Z'))).toBe(0);

    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { used: 7 } } as never);
    expect(await getUsage('hh-1', new Date('2026-06-11T00:00:00Z'))).toBe(7);
    const cmd = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      kind: string;
      input: { Key: { PK: string; SK: string } };
    };
    expect(cmd.kind).toBe('Get');
    expect(cmd.input.Key.SK).toBe('MONTH#2026-06#HH#hh-1');
  });

  it('fails OPEN: a DDB read error reports 0 used instead of blocking identify', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
    const { getUsage } = await import('../../../src/services/identifyBudget.js');
    expect(await getUsage('hh-1')).toBe(0);
  });

  it('fails SOFT on increment: a DDB write error returns null, never throws', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
    const { incrementUsage } = await import('../../../src/services/identifyBudget.js');
    expect(await incrementUsage('hh-1')).toBeNull();
  });
});
