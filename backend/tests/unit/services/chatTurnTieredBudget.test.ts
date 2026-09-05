/**
 * The tier-aware chat budget as the TURN sees it: which BudgetConfig reaches
 * the atomic gate (persistence.reserveBudget) and the remaining-budget
 * arithmetic, and how many plan lookups a turn makes. Same mock rig as
 * chatTurn.test.ts; kept separate so the budget contract has one home.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/services/chat/bedrock.js');
vi.mock('../../../src/services/chat/corpus.js');
vi.mock('../../../src/services/sprout.js', () => ({
  askSprout: vi.fn(),
  isSproutIntegrationEnabled: vi.fn(() => false),
}));
vi.mock('../../../src/services/chat/persistence.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/chat/persistence.js')>(
    '../../../src/services/chat/persistence.js'
  );
  return {
    ...actual,
    newConversationId: vi.fn(() => 'conv-1'),
    appendMessage: vi.fn(async () => undefined),
    appendMessagePair: vi.fn(async () => undefined),
    appendTurnUserMessage: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => []),
    getBudget: vi.fn(async () => ({
      householdId: 'hh-1',
      yearMonth: '2026-09',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
    })),
    // The atomic gate: returns the POST-reservation committed totals. Fresh
    // budget → post-reserve == the reservation.
    reserveBudget: vi.fn(
      async (_hh: string, reserve: { inputTokens: number; outputTokens: number }) => ({
        householdId: 'hh-1',
        yearMonth: '2026-09',
        inputTokens: reserve.inputTokens,
        outputTokens: reserve.outputTokens,
        costUsd: 0,
      })
    ),
    incrementBudget: vi.fn(async () => undefined),
    reconcileTurnBudget: vi.fn(async () => undefined),
    claimTurn: vi.fn(async () => ({
      status: 'claimed' as const,
      conversationId: 'conv-1',
      userMessagePersisted: false,
      attemptId: 'attempt-1',
    })),
    finalizeTurn: vi.fn(async () => undefined),
    markTurnRetryable: vi.fn(async () => undefined),
    releaseTurn: vi.fn(async () => undefined),
  };
});
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));

import {
  runChatTurn,
  BUDGET_CONFIG,
  RESERVE_INPUT_TOKENS,
  RESERVE_OUTPUT_TOKENS,
} from '../../../src/services/chat/index.js';
import * as billing from '../../../src/services/billing.js';
import { askSprout, isSproutIntegrationEnabled } from '../../../src/services/sprout.js';
import { invokeChatModel } from '../../../src/services/chat/bedrock.js';
import { ChatBudgetExceededError, reserveBudget } from '../../../src/services/chat/persistence.js';

const FLAT = { maxInputTokensPerMonth: 250000, maxOutputTokensPerMonth: 50000 };
const RESERVE = { inputTokens: RESERVE_INPUT_TOKENS, outputTokens: RESERVE_OUTPUT_TOKENS };

const TIER_ENV = [
  'CHAT_BUDGET_INPUT_TOKENS_SEEDLING',
  'CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING',
  'CHAT_BUDGET_INPUT_TOKENS_GARDEN',
  'CHAT_BUDGET_OUTPUT_TOKENS_GARDEN',
  'CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE',
  'CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE',
];

function clearTierEnv() {
  for (const name of TIER_ENV) delete process.env[name];
}

function answer(inputTokens = 10, outputTokens = 5) {
  vi.mocked(invokeChatModel).mockResolvedValueOnce({
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'end_turn',
    inputTokens,
    outputTokens,
    costUsd: 0.001,
  });
}

/** The BudgetConfig the gate was handed on the given call. */
function configHandedToGate(call = 0) {
  return vi.mocked(reserveBudget).mock.calls[call][2];
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTierEnv();
  delete process.env.CHAT_ENABLED;
  vi.mocked(isSproutIntegrationEnabled).mockReturnValue(false);
});
afterEach(() => {
  clearTierEnv();
});

describe('chat turn budget tiering', () => {
  it('with nothing configured the turn reserves against the flat BUDGET_CONFIG — the same object — with exactly one plan lookup (the Garden-and-up gate)', async () => {
    answer();
    const result = await runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' });

    expect(reserveBudget).toHaveBeenCalledWith('hh-1', RESERVE, BUDGET_CONFIG);
    expect(configHandedToGate()).toBe(BUDGET_CONFIG);
    expect(BUDGET_CONFIG).toEqual(FLAT);
    // Tiering added no read: the one subscription read is the plan gate that
    // already ran before this change.
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(1);
    expect(result.budgetRemaining).toEqual({ inputTokens: 250000 - 10, outputTokens: 50000 - 5 });
  });

  it("a configured tier's budget reaches the gate for that tier only, still with exactly one plan lookup", async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_GARDEN = '62500';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_GARDEN = '12500';

    // Garden (the default mocked household): its own numbers …
    answer();
    const garden = await runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' });
    expect(configHandedToGate(0)).toEqual({
      maxInputTokensPerMonth: 62500,
      maxOutputTokensPerMonth: 12500,
    });
    expect(garden.budgetRemaining).toEqual({ inputTokens: 62500 - 10, outputTokens: 12500 - 5 });
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(1);

    // … while Greenhouse, which set nothing, inherits the flat cap.
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'greenhouse' });
    answer();
    const greenhouse = await runChatTurn({ userId: 'u1', householdId: 'hh-2', message: 'hello' });
    expect(configHandedToGate(1)).toEqual(FLAT);
    expect(greenhouse.budgetRemaining).toEqual({
      inputTokens: 250000 - 10,
      outputTokens: 50000 - 5,
    });
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(2);
  });

  it('a Seedling household never reaches the gate: the Garden-and-up 402 fires first, so a Seedling cap is a floor under that gate, not a live spend', async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_SEEDLING = '62500';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING = '12500';
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(invokeChatModel).not.toHaveBeenCalled();
  });

  it('a failed plan lookup fails closed once tiers are configured: no reservation, no Bedrock call', async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_GARDEN = '62500';
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValueOnce(new Error('ddb down'));

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toThrow('ddb down');
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(invokeChatModel).not.toHaveBeenCalled();
  });

  it('a household mid-month above a newly lowered tier cap gets the 429 the flat gate has always produced, before Bedrock', async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_GARDEN = '62500';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_GARDEN = '12500';
    // The conditional ADD is the authority: it fails for a counter already
    // past (cap - reserve), whether that counter got there under this cap or
    // the previous, larger one.
    vi.mocked(reserveBudget).mockRejectedValueOnce(new ChatBudgetExceededError());

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(configHandedToGate()).toEqual({
      maxInputTokensPerMonth: 62500,
      maxOutputTokensPerMonth: 12500,
    });
    expect(invokeChatModel).not.toHaveBeenCalled();
  });

  it("the Sprout path reports remaining budget against the tier's cap too", async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_GARDEN = '62500';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_GARDEN = '12500';
    vi.mocked(isSproutIntegrationEnabled).mockReturnValue(true);
    vi.mocked(askSprout).mockResolvedValueOnce({
      text: 'Water it weekly.',
      citations: [],
      // The full five-field contract. `observations`, `disclosure` and
      // `coverage` are required of askSprout, so a fixture that omits them is
      // testing a shape the service cannot return (#570, #579).
      observations: [],
      disclosure: 'General information, not veterinary advice.',
      coverage: {
        plants: { total: 1, included: 1, unmatched: 0, truncated: 0, cap: 100, complete: true },
        tasks: { total: 1, included: 1, unmatched: 0, truncated: 0, cap: 100, complete: true },
        partial: false,
      },
    });

    const result = await runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' });

    expect(result.provider).toBe('sprout');
    // getBudget (mocked) reports 100 / 20 used this month.
    expect(result.budgetRemaining).toEqual({ inputTokens: 62500 - 100, outputTokens: 12500 - 20 });
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(1);
  });
});
