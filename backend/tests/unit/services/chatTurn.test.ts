/**
 * Exercises the runChatTurn loop end-to-end with Bedrock + DDB mocked.
 * Catches the regressions you can't see in the tool-registry tests: tool
 * call cap, history fetching, budget gating, persistence shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/chat/bedrock.js');
vi.mock('../../../src/services/chat/persistence.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/chat/persistence.js')>(
    '../../../src/services/chat/persistence.js'
  );
  return {
    ...actual,
    newConversationId: vi.fn(() => 'conv-1'),
    appendMessage: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => []),
    getBudget: vi.fn(async () => ({
      householdId: 'hh-1',
      yearMonth: '2026-05',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })),
    incrementBudget: vi.fn(async () => undefined),
  };
});
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');

import { runChatTurn, BUDGET_CONFIG } from '../../../src/services/chat/index.js';
import { invokeChatModel } from '../../../src/services/chat/bedrock.js';
import {
  appendMessage,
  getBudget,
  incrementBudget,
} from '../../../src/services/chat/persistence.js';
import * as plantService from '../../../src/services/plantService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runChatTurn', () => {
  it('returns the assistant text and persists exactly the right turns on a no-tool answer', async () => {
    vi.mocked(invokeChatModel).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'You have no plants yet.' }],
      stopReason: 'end_turn',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0006,
    });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'What plants do I have?',
    });

    expect(result.conversationId).toBe('conv-1');
    expect(result.assistantText).toBe('You have no plants yet.');
    // One user turn + one assistant turn persisted.
    expect(vi.mocked(appendMessage)).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(appendMessage).mock.calls;
    expect(calls[0][1].role).toBe('user');
    expect(calls[1][1].role).toBe('assistant');
    // Budget incremented once with the full turn's usage.
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0006,
    });
  });

  it('runs the tool-use loop: tool_use → tool execution → final answer', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([
      {
        id: 'p1',
        householdId: 'hh-1',
        name: 'Bertha',
        species: 'Monstera',
        location: null,
        imageUrl: null,
        notes: null,
        tags: [],
        createdAt: '2025-01-01',
        createdBy: 'u1',
        updatedAt: '2025-01-01',
      },
    ]);

    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'list_household_plants',
            input: {},
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 200,
        outputTokens: 30,
        costUsd: 0.001,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You have 1 plant: Bertha (Monstera).' }],
        stopReason: 'end_turn',
        inputTokens: 250,
        outputTokens: 40,
        costUsd: 0.0015,
      });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'list my plants',
    });

    expect(result.assistantText).toContain('Bertha');
    expect(vi.mocked(plantService.getPlants)).toHaveBeenCalledWith('hh-1');
    // Bedrock called twice (tool_use turn + final turn).
    expect(vi.mocked(invokeChatModel)).toHaveBeenCalledTimes(2);
    // Combined budget update.
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 450,
      outputTokens: 70,
      costUsd: 0.0025,
    });
  });

  it('refuses to invoke Bedrock when the household is over budget', async () => {
    vi.mocked(getBudget).mockResolvedValueOnce({
      householdId: 'hh-1',
      yearMonth: '2026-05',
      inputTokens: BUDGET_CONFIG.maxInputTokensPerMonth,
      outputTokens: 0,
      costUsd: 1,
    });

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(vi.mocked(invokeChatModel)).not.toHaveBeenCalled();
    expect(vi.mocked(incrementBudget)).not.toHaveBeenCalled();
  });

  it('returns an error tool_result when the model calls an unknown tool', async () => {
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu-bad',
            name: 'no_such_tool',
            input: {},
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 50,
        outputTokens: 10,
        costUsd: 0.0001,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'I tried something I shouldn’t have.' }],
        stopReason: 'end_turn',
        inputTokens: 60,
        outputTokens: 15,
        costUsd: 0.0002,
      });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'hi',
    });

    // Final answer is whatever the model returned on the recovery turn.
    expect(result.assistantText).toContain('shouldn');
    // The tool error was passed back to the model — we'd expect the second
    // invokeChatModel call's `messages` arg to include the error tool_result.
    const secondCall = vi.mocked(invokeChatModel).mock.calls[1][0];
    const lastUserTurn = secondCall.messages.at(-1);
    expect(lastUserTurn?.role).toBe('user');
    const firstBlock = lastUserTurn?.content[0];
    expect(firstBlock).toMatchObject({
      type: 'tool_result',
      is_error: true,
    });
    if (firstBlock && firstBlock.type === 'tool_result') {
      expect(firstBlock.content).toContain('Unknown tool');
    }
  });
});
