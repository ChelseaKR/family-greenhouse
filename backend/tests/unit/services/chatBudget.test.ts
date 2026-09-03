/**
 * The tier-aware chat token budget (services/chat/budget.ts) and the gate it
 * feeds (persistence.reserveBudget). Mirrors leafHealthBudget.test.ts: the
 * deploy-safety contract is that with nothing configured every tier gets the
 * flat 250k / 50k from the very same BUDGET_CONFIG object with no plan lookup,
 * and that a configured tier lands in BOTH counters' conditions unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));
// One `send` for the life of the file (vi.hoisted), so the cold-start tests
// below can vi.resetModules() and re-import without losing the handle.
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send },
  TABLE_NAME: 'test-table',
}));

import {
  BUDGET_CONFIG,
  CHAT_BUDGET_ENV,
  allowanceForPlan,
  allowances,
  budgetConfigForPlan,
  resolveBudgetConfig,
  tierAware,
} from '../../../src/services/chat/budget.js';
import {
  ChatBudgetExceededError,
  incrementBudget,
  isOverBudget,
  reconcileTurnBudget,
  reserveBudget,
} from '../../../src/services/chat/persistence.js';

const FLAT = { maxInputTokensPerMonth: 250000, maxOutputTokensPerMonth: 50000 };
const RESERVE = { inputTokens: 8000, outputTokens: 2048 };
const CONDITION =
  '(attribute_not_exists(inputTokens) OR inputTokens <= :inThreshold) AND (attribute_not_exists(outputTokens) OR outputTokens <= :outThreshold)';

const BUDGET_ENV = [
  'CHAT_BUDGET_INPUT_TOKENS',
  'CHAT_BUDGET_OUTPUT_TOKENS',
  'CHAT_BUDGET_INPUT_TOKENS_SEEDLING',
  'CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING',
  'CHAT_BUDGET_INPUT_TOKENS_GARDEN',
  'CHAT_BUDGET_OUTPUT_TOKENS_GARDEN',
  'CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE',
  'CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE',
];

function clearBudgetEnv() {
  for (const name of BUDGET_ENV) delete process.env[name];
}

/** The production free-tier values: 25% of the flat cap on both counters. */
function configureSeedling() {
  process.env.CHAT_BUDGET_INPUT_TOKENS_SEEDLING = '62500';
  process.env.CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING = '12500';
}

type UpdateCmd = {
  kind: string;
  input: {
    Key: { PK: string; SK: string };
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeValues: Record<string, number | string>;
  };
};

function sentUpdate(i = 0): UpdateCmd {
  return send.mock.calls[i][0] as unknown as UpdateCmd;
}

describe('chat budget (services/chat/budget.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBudgetEnv();
  });
  afterEach(() => {
    clearBudgetEnv();
  });

  describe('cap configuration', () => {
    it('with nothing configured every tier gets the flat 250k / 50k from the SAME object — the pre-tiering behaviour, exactly', () => {
      // The deploy-safety contract: a build that adds the per-tier variables
      // (all blank) must enforce the same numbers as before for every plan,
      // and must not become tier-aware (no plan lookup anywhere).
      expect(BUDGET_CONFIG).toEqual(FLAT);
      expect(tierAware()).toBe(false);
      expect(allowances()).toEqual({ seedling: FLAT, garden: FLAT, greenhouse: FLAT });
      for (const id of ['seedling', 'garden', 'greenhouse'] as const) {
        expect(allowanceForPlan(id)).toEqual(BUDGET_CONFIG);
        // Not just equal: the flat constant itself flows to the gate.
        expect(budgetConfigForPlan(id)).toBe(BUDGET_CONFIG);
      }
    });

    it('a flat CHAT_BUDGET_* alone (read once at cold start) still applies to every tier and is not tier-aware', async () => {
      vi.resetModules();
      process.env.CHAT_BUDGET_INPUT_TOKENS = '100000';
      process.env.CHAT_BUDGET_OUTPUT_TOKENS = '20000';
      const fresh = await import('../../../src/services/chat/budget.js');
      const flat = { maxInputTokensPerMonth: 100000, maxOutputTokensPerMonth: 20000 };
      expect(fresh.BUDGET_CONFIG).toEqual(flat);
      expect(fresh.tierAware()).toBe(false);
      expect(fresh.allowances()).toEqual({ seedling: flat, garden: flat, greenhouse: flat });
      expect(fresh.budgetConfigForPlan('greenhouse')).toBe(fresh.BUDGET_CONFIG);
    });

    it('a blank flat value means "use the default", never a zero budget (`||`, not `??`)', async () => {
      vi.resetModules();
      process.env.CHAT_BUDGET_INPUT_TOKENS = '';
      process.env.CHAT_BUDGET_OUTPUT_TOKENS = '';
      const fresh = await import('../../../src/services/chat/budget.js');
      expect(fresh.BUDGET_CONFIG).toEqual(FLAT);
    });

    it('per-tier values override the flat cap only for the tiers AND counters that set them', () => {
      configureSeedling();
      process.env.CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE = '500000';
      expect(tierAware()).toBe(true);
      expect(allowances()).toEqual({
        seedling: { maxInputTokensPerMonth: 62500, maxOutputTokensPerMonth: 12500 },
        // Garden set nothing: inherits the flat cap on both counters …
        garden: FLAT,
        // … and Greenhouse set only input, so output inherits on its own.
        greenhouse: { maxInputTokensPerMonth: 500000, maxOutputTokensPerMonth: 50000 },
      });
      // The production free-tier numbers are exactly 25% of the flat cap.
      expect(allowanceForPlan('seedling')).toEqual({
        maxInputTokensPerMonth: FLAT.maxInputTokensPerMonth / 4,
        maxOutputTokensPerMonth: FLAT.maxOutputTokensPerMonth / 4,
      });
    });

    it('a per-tier 0 is a ZERO budget for that tier (counts as configured; not "unlimited" — Terraform refuses it)', async () => {
      process.env.CHAT_BUDGET_INPUT_TOKENS_GARDEN = '0';
      expect(tierAware()).toBe(true);
      expect(allowanceForPlan('garden').maxInputTokensPerMonth).toBe(0);
      expect(allowanceForPlan('seedling').maxInputTokensPerMonth).toBe(250000);
      // What that does at the gate: the input threshold goes negative, so
      // every reservation after the month's first (which passes only via
      // attribute_not_exists on a fresh row) fails its condition → 429. The
      // same meaning the flat cap has always given 0.
      send.mockResolvedValueOnce({ Attributes: { inputTokens: 8000, outputTokens: 2048 } });
      await reserveBudget('hh', RESERVE, allowanceForPlan('garden'));
      expect(sentUpdate().input.ExpressionAttributeValues[':inThreshold']).toBe(-8000);
    });

    it('an unparseable per-tier value is ignored (inherits the flat cap) rather than NaN-ing the gate', () => {
      process.env.CHAT_BUDGET_OUTPUT_TOKENS_GARDEN = 'lots';
      expect(tierAware()).toBe(false);
      expect(allowanceForPlan('garden')).toEqual(FLAT);
      expect(budgetConfigForPlan('garden')).toBe(BUDGET_CONFIG);
    });

    it('CHAT_BUDGET_ENV names the variables each tier reads (the tfvars/docs contract)', () => {
      expect(CHAT_BUDGET_ENV).toEqual({
        seedling: {
          input: 'CHAT_BUDGET_INPUT_TOKENS_SEEDLING',
          output: 'CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING',
        },
        garden: {
          input: 'CHAT_BUDGET_INPUT_TOKENS_GARDEN',
          output: 'CHAT_BUDGET_OUTPUT_TOKENS_GARDEN',
        },
        greenhouse: {
          input: 'CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE',
          output: 'CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE',
        },
      });
    });
  });

  describe('resolveBudgetConfig / budgetConfigForPlan', () => {
    it('never looks the plan up while only the flat cap is configured', async () => {
      const lookupPlanId = vi.fn().mockResolvedValue('greenhouse');
      await expect(resolveBudgetConfig(lookupPlanId)).resolves.toBe(BUDGET_CONFIG);
      expect(lookupPlanId).not.toHaveBeenCalled();
    });

    it("looks the plan up once per-tier caps exist and returns that tier's budget", async () => {
      configureSeedling();
      const lookupPlanId = vi.fn().mockResolvedValue('seedling');
      await expect(resolveBudgetConfig(lookupPlanId)).resolves.toEqual({
        maxInputTokensPerMonth: 62500,
        maxOutputTokensPerMonth: 12500,
      });
      expect(lookupPlanId).toHaveBeenCalledTimes(1);
      // A tier without its own values inherits the flat cap.
      lookupPlanId.mockResolvedValue('garden');
      await expect(resolveBudgetConfig(lookupPlanId)).resolves.toEqual(FLAT);
    });

    it('propagates a failed plan lookup — a cap we cannot determine is not one to spend against', async () => {
      configureSeedling();
      const lookupPlanId = vi.fn().mockRejectedValue(new Error('ddb down'));
      await expect(resolveBudgetConfig(lookupPlanId)).rejects.toThrow('ddb down');
    });

    it('budgetConfigForPlan (plan already in hand) switches from the flat constant to the tier budget', () => {
      expect(budgetConfigForPlan('seedling')).toBe(BUDGET_CONFIG);
      configureSeedling();
      expect(budgetConfigForPlan('seedling')).toEqual({
        maxInputTokensPerMonth: 62500,
        maxOutputTokensPerMonth: 12500,
      });
      expect(budgetConfigForPlan('garden')).toEqual(FLAT);
    });
  });

  describe('the gate (persistence.reserveBudget) with a tiered budget', () => {
    it('with nothing configured the reservation carries the flat thresholds — the write this gate has always made', async () => {
      send.mockResolvedValueOnce({ Attributes: { inputTokens: 8000, outputTokens: 2048 } });
      const config = budgetConfigForPlan('garden');
      expect(config).toBe(BUDGET_CONFIG);

      await reserveBudget('hh-1', RESERVE, config);

      const cmd = sentUpdate();
      expect(cmd.kind).toBe('Update');
      expect(cmd.input.ConditionExpression).toBe(CONDITION);
      expect(cmd.input.UpdateExpression).toContain('ADD inputTokens :rin, outputTokens :rout');
      expect(cmd.input.ExpressionAttributeValues[':inThreshold']).toBe(250000 - 8000);
      expect(cmd.input.ExpressionAttributeValues[':outThreshold']).toBe(50000 - 2048);
    });

    it("a configured tier lands in BOTH counters' conditions unchanged — same conditional ADD, same expression, same reserve", async () => {
      configureSeedling();
      send.mockResolvedValueOnce({ Attributes: { inputTokens: 8000, outputTokens: 2048 } });

      const state = await reserveBudget('hh-1', RESERVE, budgetConfigForPlan('seedling'));
      expect(state.inputTokens).toBe(8000);

      const cmd = sentUpdate();
      // Still reserve-before-call: one conditional ADD is the gate, and the
      // tier changed nothing but the two threshold values.
      expect(cmd.input.Key.SK).toMatch(/^CHATBUDGET#\d{4}-\d{2}$/);
      expect(cmd.input.ConditionExpression).toBe(CONDITION);
      expect(cmd.input.ExpressionAttributeValues[':rin']).toBe(8000);
      expect(cmd.input.ExpressionAttributeValues[':rout']).toBe(2048);
      expect(cmd.input.ExpressionAttributeValues[':inThreshold']).toBe(62500 - 8000);
      expect(cmd.input.ExpressionAttributeValues[':outThreshold']).toBe(12500 - 2048);
    });

    it('a household already past a newly lowered cap mid-month is refused on its NEXT turn — nothing is revoked or clamped', async () => {
      configureSeedling();
      // 100k input tokens committed under the old 250k cap; the tier now
      // allows 62.5k. Under the old cap this household was fine …
      const used = {
        householdId: 'hh-1',
        yearMonth: '2026-09',
        inputTokens: 100000,
        outputTokens: 9000,
        costUsd: 0.2,
      };
      expect(isOverBudget(used, BUDGET_CONFIG)).toBe(false);
      // … under the new one it is over, and the gate's condition
      // (100000 <= 62500 - 8000) fails, which DynamoDB reports as a
      // conditional-check failure → the 429 the flat gate has always produced.
      expect(isOverBudget(used, budgetConfigForPlan('seedling'))).toBe(true);
      send.mockRejectedValueOnce(
        Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })
      );
      await expect(
        reserveBudget('hh-1', RESERVE, budgetConfigForPlan('seedling'))
      ).rejects.toBeInstanceOf(ChatBudgetExceededError);
      // Exactly one write was attempted: the counter is neither reset nor
      // clamped to the new cap, and the household is simply blocked until the
      // month key rolls over — the same "lower caps on the 1st" rule as the
      // other guards.
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('a turn already in flight under the old cap still reconciles to its actual usage — the cap is not in the reconcile write', async () => {
      configureSeedling();
      const reconciliation = {
        reconciliationId: 'r-1',
        yearMonth: '2026-09',
        inputTokens: -3000,
        outputTokens: -1000,
        costUsd: 0.01,
        status: 'pending' as const,
      };
      send.mockResolvedValueOnce({}); // budget ADD + ledger Put transaction
      send.mockResolvedValueOnce({}); // turn-row status bookkeeping
      await reconcileTurnBudget('hh-1', 'turn-1', reconciliation);

      const tx = send.mock.calls[0][0] as unknown as {
        kind: string;
        input: {
          TransactItems: Array<{
            Update?: { UpdateExpression: string; ConditionExpression?: string };
          }>;
        };
      };
      expect(tx.kind).toBe('TransactWrite');
      const update = tx.input.TransactItems[0].Update;
      expect(update?.UpdateExpression).toContain(
        'ADD inputTokens :in, outputTokens :out, costUsd :cost'
      );
      // Unconditional: the estimate-then-reconcile flow is untouched by
      // tiering, so a turn that overshoots a freshly lowered cap simply lands
      // over it (and the next reservation is what gets refused).
      expect(update?.ConditionExpression).toBeUndefined();

      // The legacy (no turnId) reconcile is the same unconditional ADD.
      send.mockResolvedValueOnce({});
      await incrementBudget('hh-1', { inputTokens: -3000, outputTokens: -1000, costUsd: 0.01 });
      expect(sentUpdate(2).input.ConditionExpression).toBeUndefined();
    });

    it('fails CLOSED when a reservation cannot be persisted — the DDB error propagates, never a stand-in success', async () => {
      configureSeedling();
      send.mockRejectedValueOnce(new Error('throttled'));
      await expect(reserveBudget('hh-1', RESERVE, budgetConfigForPlan('seedling'))).rejects.toThrow(
        'throttled'
      );
    });
  });
});
