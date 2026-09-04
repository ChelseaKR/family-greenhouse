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

// The credit pool is its own module with its own tests; here it is a
// collaborator whose three outcomes (spent / exhausted / unreadable) drive
// the consumption-order contract.
const { consumeCredit, CreditsExhausted } = vi.hoisted(() => ({
  consumeCredit: vi.fn(),
  CreditsExhausted: class IdentifyCreditsExhaustedError extends Error {},
}));
vi.mock('../../../src/services/identifyCredits.js', () => ({
  consumeCredit,
  IdentifyCreditsExhaustedError: CreditsExhausted,
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

  it('fails OPEN without inventing a reading: a DDB read error is null, not 0', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
    const { getUsage } = await import('../../../src/services/identifyBudget.js');
    // Still fails open — it resolves rather than throwing, so metering can
    // never take down identify. But "we could not read the counter" is not
    // the same fact as "nothing has been spent this month", and this value is
    // published to the client as `usage.used`.
    await expect(getUsage('hh-1')).resolves.toBeNull();
  });

  it('a genuinely missing row is a real zero, not unknown', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    const { getUsage } = await import('../../../src/services/identifyBudget.js');
    await expect(getUsage('hh-1')).resolves.toBe(0);
  });

  it('fails SOFT on increment: a DDB write error returns null, never throws', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
    const { incrementUsage } = await import('../../../src/services/identifyBudget.js');
    expect(await incrementUsage('hh-1')).toBeNull();
  });

  it('reserves a paid attempt with one conditional atomic update', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { used: 3 } } as never);
    const { reserveUsage } = await import('../../../src/services/identifyBudget.js');

    await expect(reserveUsage('hh-1', 3, new Date('2026-06-11T12:00:00Z'))).resolves.toBe(3);

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: {
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(#used) OR #used < :allowance');
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({
      ':one': 1,
      ':allowance': 3,
    });
  });

  it('rejects the caller that would exceed the monthly allowance', async () => {
    const conditional = new Error('conditional');
    conditional.name = 'ConditionalCheckFailedException';
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditional as never);
    const { IdentifyBudgetExceededError, reserveUsage } =
      await import('../../../src/services/identifyBudget.js');

    await expect(reserveUsage('hh-1', 3)).rejects.toBeInstanceOf(IdentifyBudgetExceededError);
  });

  it('fails closed when an enforced reservation cannot be persisted', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
    const { reserveUsage } = await import('../../../src/services/identifyBudget.js');

    await expect(reserveUsage('hh-1', 3)).rejects.toThrow('throttled');
  });

  describe('reserveIdentification — consumption order (ADR 0019)', () => {
    const NOW = new Date('2026-09-03T12:00:00Z');
    const conditional = () =>
      Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

    it('spends the plan allowance first and never consults credits while it lasts', async () => {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { used: 4 } } as never);
      const { reserveIdentification } = await import('../../../src/services/identifyBudget.js');
      await expect(reserveIdentification('hh-1', 30, 'hh-1', NOW)).resolves.toEqual({
        used: 4,
        source: 'allowance',
      });
      expect(consumeCredit).not.toHaveBeenCalled();
    });

    it('draws one credit only once the allowance is refused, and reports the balance after', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(conditional() as never);
      consumeCredit.mockResolvedValueOnce({ remaining: 19, expiresAt: '2027-09-03T12:00:00.000Z' });
      const { reserveIdentification } = await import('../../../src/services/identifyBudget.js');
      await expect(reserveIdentification('hh-1', 30, 'hh-1', NOW)).resolves.toEqual({
        // The month meter is full — that is the fact the client renders.
        used: 30,
        source: 'credit',
        credits: { remaining: 19, expiresAt: '2027-09-03T12:00:00.000Z' },
      });
      expect(consumeCredit).toHaveBeenCalledWith('hh-1', NOW);
    });

    it('refuses with a REAL zero when the allowance is spent and no pack has a credit', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(conditional() as never);
      consumeCredit.mockRejectedValueOnce(new CreditsExhausted('none'));
      const { reserveIdentification, IdentifyBudgetExceededError } =
        await import('../../../src/services/identifyBudget.js');
      const err = await reserveIdentification('hh-1', 30, 'hh-1', NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdentifyBudgetExceededError);
      expect((err as InstanceType<typeof IdentifyBudgetExceededError>).credits).toEqual({
        remaining: 0,
        expiresAt: null,
      });
    });

    it('a householdless caller has nowhere to hold a pack: credits are not consulted, not zero', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(conditional() as never);
      const { reserveIdentification, IdentifyBudgetExceededError } =
        await import('../../../src/services/identifyBudget.js');
      const err = await reserveIdentification('user:u-1', 3, null, NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdentifyBudgetExceededError);
      expect((err as InstanceType<typeof IdentifyBudgetExceededError>).credits).toBeNull();
      expect(consumeCredit).not.toHaveBeenCalled();
    });

    it('fails CLOSED when the credit read fails — never "your pack is empty", never an unmetered call', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(conditional() as never);
      consumeCredit.mockRejectedValueOnce(new Error('credits throttled'));
      const { reserveIdentification, IdentifyBudgetExceededError } =
        await import('../../../src/services/identifyBudget.js');
      const err = await reserveIdentification('hh-1', 30, 'hh-1', NOW).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(IdentifyBudgetExceededError);
      expect((err as Error).message).toBe('credits throttled');
    });

    it('propagates an allowance infrastructure failure without touching credits', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
      const { reserveIdentification } = await import('../../../src/services/identifyBudget.js');
      await expect(reserveIdentification('hh-1', 30, 'hh-1', NOW)).rejects.toThrow('throttled');
      expect(consumeCredit).not.toHaveBeenCalled();
    });
  });
});
