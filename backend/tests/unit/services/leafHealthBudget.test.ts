import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn((i) => ({ input: i, kind: 'Get' })),
  UpdateCommand: vi.fn((i) => ({ input: i, kind: 'Update' })),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';

describe('leafHealthBudget service (M1 — monthly Bedrock spend cap)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LEAF_HEALTH_MONTHLY_CAP;
  });
  afterEach(() => {
    delete process.env.LEAF_HEALTH_MONTHLY_CAP;
  });

  it('defaults the cap to 200 and reads LEAF_HEALTH_MONTHLY_CAP when set', async () => {
    const { monthlyCap } = await import('../../../src/services/leafHealthBudget.js');
    expect(monthlyCap()).toBe(200);
    process.env.LEAF_HEALTH_MONTHLY_CAP = '50';
    expect(monthlyCap()).toBe(50);
    // Unparseable falls back to the default rather than NaN-ing the gate.
    process.env.LEAF_HEALTH_MONTHLY_CAP = 'nope';
    expect(monthlyCap()).toBe(200);
  });

  it('isOverCap returns false (unlimited) when the cap is <= 0', async () => {
    const { isOverCap } = await import('../../../src/services/leafHealthBudget.js');
    process.env.LEAF_HEALTH_MONTHLY_CAP = '0';
    // No usage read needed when unlimited.
    expect(await isOverCap('hh')).toBe(false);
    expect(vi.mocked(dynamodb.send)).not.toHaveBeenCalled();
  });

  it('isOverCap is true once usage reaches the cap, false below', async () => {
    const { isOverCap } = await import('../../../src/services/leafHealthBudget.js');
    process.env.LEAF_HEALTH_MONTHLY_CAP = '3';

    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { used: 2 } } as never);
    expect(await isOverCap('hh')).toBe(false);

    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { used: 3 } } as never);
    expect(await isOverCap('hh')).toBe(true);
  });

  it('getUsage fails OPEN (0) on a DDB error — the cap never breaks the feature', async () => {
    const { getUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));
    expect(await getUsage('hh')).toBe(0);
  });

  it('incrementUsage atomically ADDs one against the household month partition', async () => {
    const { incrementUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { used: 4 } } as never);
    const used = await incrementUsage('hh', new Date('2026-06-15T00:00:00Z'));
    expect(used).toBe(4);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Key: { PK: string; SK: string }; UpdateExpression: string };
    };
    expect(cmd.input.Key.PK).toBe('LEAFHEALTH#BUDGET');
    expect(cmd.input.Key.SK).toBe('MONTH#2026-06#HH#hh');
    expect(cmd.input.UpdateExpression).toContain('ADD #used :one');
  });

  it('incrementUsage returns null on a DDB error (soft failure)', async () => {
    const { incrementUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));
    expect(await incrementUsage('hh')).toBeNull();
  });
});
