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

const CAP_ENV = [
  'LEAF_HEALTH_MONTHLY_CAP',
  'LEAF_HEALTH_MONTHLY_CAP_SEEDLING',
  'LEAF_HEALTH_MONTHLY_CAP_GARDEN',
  'LEAF_HEALTH_MONTHLY_CAP_GREENHOUSE',
];

function clearCapEnv() {
  for (const name of CAP_ENV) delete process.env[name];
}

describe('leafHealthBudget service (M1 — monthly Bedrock spend cap)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCapEnv();
  });
  afterEach(() => {
    clearCapEnv();
  });

  describe('cap configuration', () => {
    it('defaults the cap to 200 and reads LEAF_HEALTH_MONTHLY_CAP when set', async () => {
      const { monthlyCap } = await import('../../../src/services/leafHealthBudget.js');
      expect(monthlyCap()).toBe(200);
      process.env.LEAF_HEALTH_MONTHLY_CAP = '50';
      expect(monthlyCap()).toBe(50);
      // Unparseable falls back to the default rather than NaN-ing the gate.
      process.env.LEAF_HEALTH_MONTHLY_CAP = 'nope';
      expect(monthlyCap()).toBe(200);
    });

    it('with nothing configured every tier gets the flat 200 — the pre-tiering behaviour, exactly', async () => {
      const { allowances, allowanceForPlan, tierAware, monthlyCap } =
        await import('../../../src/services/leafHealthBudget.js');
      // This is the deploy-safety contract: a build that adds the per-tier
      // variables (all blank) must enforce the same number as before for
      // every plan, and must not become tier-aware (no plan lookup).
      expect(tierAware()).toBe(false);
      expect(allowances()).toEqual({ seedling: 200, garden: 200, greenhouse: 200 });
      for (const id of ['seedling', 'garden', 'greenhouse'] as const) {
        expect(allowanceForPlan(id)).toBe(monthlyCap());
      }
    });

    it('a flat LEAF_HEALTH_MONTHLY_CAP alone still applies to every tier and is not tier-aware', async () => {
      const { allowances, tierAware } = await import('../../../src/services/leafHealthBudget.js');
      process.env.LEAF_HEALTH_MONTHLY_CAP = '50';
      expect(tierAware()).toBe(false);
      expect(allowances()).toEqual({ seedling: 50, garden: 50, greenhouse: 50 });
    });

    it('per-tier values override the flat cap only for the tiers that set them', async () => {
      const { allowances, tierAware } = await import('../../../src/services/leafHealthBudget.js');
      process.env.LEAF_HEALTH_MONTHLY_CAP_SEEDLING = '20';
      process.env.LEAF_HEALTH_MONTHLY_CAP_GREENHOUSE = '400';
      expect(tierAware()).toBe(true);
      // Garden was not set, so it inherits the flat cap — the default 200 …
      expect(allowances()).toEqual({ seedling: 20, garden: 200, greenhouse: 400 });
      // … or whatever the flat cap is configured to.
      process.env.LEAF_HEALTH_MONTHLY_CAP = '150';
      expect(allowances()).toEqual({ seedling: 20, garden: 150, greenhouse: 400 });
    });

    it('a per-tier 0 disables the gate for that tier only (unlimited) and counts as configured', async () => {
      const { allowanceForPlan, tierAware } =
        await import('../../../src/services/leafHealthBudget.js');
      process.env.LEAF_HEALTH_MONTHLY_CAP_GREENHOUSE = '0';
      expect(tierAware()).toBe(true);
      expect(allowanceForPlan('greenhouse')).toBe(0);
      expect(allowanceForPlan('seedling')).toBe(200);
    });

    it('an unparseable per-tier value is ignored (inherits the flat cap) rather than NaN-ing the gate', async () => {
      const { allowanceForPlan, tierAware } =
        await import('../../../src/services/leafHealthBudget.js');
      process.env.LEAF_HEALTH_MONTHLY_CAP_GARDEN = 'lots';
      expect(tierAware()).toBe(false);
      expect(allowanceForPlan('garden')).toBe(200);
    });

    it('LEAF_HEALTH_CAP_ENV names the variable each tier reads (the tfvars/docs contract)', async () => {
      const { LEAF_HEALTH_CAP_ENV } = await import('../../../src/services/leafHealthBudget.js');
      expect(LEAF_HEALTH_CAP_ENV).toEqual({
        seedling: 'LEAF_HEALTH_MONTHLY_CAP_SEEDLING',
        garden: 'LEAF_HEALTH_MONTHLY_CAP_GARDEN',
        greenhouse: 'LEAF_HEALTH_MONTHLY_CAP_GREENHOUSE',
      });
    });
  });

  describe('resolveMonthlyCap', () => {
    it('never looks the plan up while only the flat cap is configured', async () => {
      const { resolveMonthlyCap } = await import('../../../src/services/leafHealthBudget.js');
      const lookupPlanId = vi.fn().mockResolvedValue('greenhouse');
      await expect(resolveMonthlyCap(lookupPlanId)).resolves.toBe(200);
      process.env.LEAF_HEALTH_MONTHLY_CAP = '75';
      await expect(resolveMonthlyCap(lookupPlanId)).resolves.toBe(75);
      expect(lookupPlanId).not.toHaveBeenCalled();
    });

    it("looks the plan up once per-tier caps exist and returns that tier's cap", async () => {
      const { resolveMonthlyCap } = await import('../../../src/services/leafHealthBudget.js');
      process.env.LEAF_HEALTH_MONTHLY_CAP_SEEDLING = '20';
      const lookupPlanId = vi.fn().mockResolvedValue('seedling');
      await expect(resolveMonthlyCap(lookupPlanId)).resolves.toBe(20);
      expect(lookupPlanId).toHaveBeenCalledTimes(1);
      // A tier without its own value inherits the flat cap.
      lookupPlanId.mockResolvedValue('garden');
      await expect(resolveMonthlyCap(lookupPlanId)).resolves.toBe(200);
    });

    it('propagates a failed plan lookup — a cap we cannot determine is not one to spend against', async () => {
      const { resolveMonthlyCap } = await import('../../../src/services/leafHealthBudget.js');
      process.env.LEAF_HEALTH_MONTHLY_CAP_SEEDLING = '20';
      const lookupPlanId = vi.fn().mockRejectedValue(new Error('ddb down'));
      await expect(resolveMonthlyCap(lookupPlanId)).rejects.toThrow('ddb down');
    });
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

  it('getUsage reports a MISSING row as a real 0', async () => {
    const { getUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    expect(await getUsage('hh')).toBe(0);
  });

  it('getUsage reports a FAILED read as null, not as a stand-in 0', async () => {
    const { getUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));
    // "nothing spent this month" and "we could not read the total" are
    // different facts; collapsing them to 0 is the defect already fixed in
    // identifyBudget.getUsage.
    expect(await getUsage('hh')).toBeNull();
  });

  it('isOverCap still fails OPEN on an unknown total — the cap never breaks the feature', async () => {
    const { isOverCap } = await import('../../../src/services/leafHealthBudget.js');
    process.env.LEAF_HEALTH_MONTHLY_CAP = '3';
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));
    // Behaviour is unchanged; the decision is now made (and logged) at the
    // call site instead of being hidden inside getUsage's return value.
    expect(await isOverCap('hh')).toBe(false);
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

  it('atomically reserves a check only while usage is below the cap', async () => {
    const { reserveUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { used: 3 } } as never);

    await expect(reserveUsage('hh', 5, new Date('2026-06-15T00:00:00Z'))).resolves.toBe(3);

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: {
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, number>;
      };
    };
    expect(cmd.input.ConditionExpression).toContain('#used < :cap');
    expect(cmd.input.ExpressionAttributeValues[':cap']).toBe(5);
  });

  it('enforces whatever cap the caller resolved — a tiered cap flows into the conditional write unchanged', async () => {
    const { resolveMonthlyCap, reserveUsage } =
      await import('../../../src/services/leafHealthBudget.js');
    process.env.LEAF_HEALTH_MONTHLY_CAP_SEEDLING = '20';
    const cap = await resolveMonthlyCap(async () => 'seedling');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: { used: 1 } } as never);

    await expect(reserveUsage('hh', cap)).resolves.toBe(1);

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: {
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, number>;
      };
    };
    // Still the reserve-before-call pattern: one conditional ADD is the gate.
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(#used) OR #used < :cap');
    expect(cmd.input.ExpressionAttributeValues[':cap']).toBe(20);
  });

  it('maps a failed reservation condition to the monthly-limit error', async () => {
    const { LeafHealthBudgetExceededError, reserveUsage } =
      await import('../../../src/services/leafHealthBudget.js');
    const conditionFailure = new Error('at cap');
    conditionFailure.name = 'ConditionalCheckFailedException';
    vi.mocked(dynamodb.send).mockRejectedValueOnce(conditionFailure);

    await expect(reserveUsage('hh', 5)).rejects.toBeInstanceOf(LeafHealthBudgetExceededError);
  });

  it('fails CLOSED when a reservation cannot be persisted — the DDB error propagates, never a stand-in success', async () => {
    const { reserveUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));

    await expect(reserveUsage('hh', 200)).rejects.toThrow('throttled');
  });

  it('best-effort releases a demo-mode reservation', async () => {
    const { releaseUsage } = await import('../../../src/services/leafHealthBudget.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);

    await expect(releaseUsage('hh')).resolves.toBeUndefined();

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: {
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, number>;
      };
    };
    expect(cmd.input.UpdateExpression).toBe('ADD #used :minusOne');
    expect(cmd.input.ConditionExpression).toContain('#used > :zero');
    expect(cmd.input.ExpressionAttributeValues[':minusOne']).toBe(-1);
  });
});
