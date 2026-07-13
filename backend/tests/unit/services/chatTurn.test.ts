/**
 * Exercises the runChatTurn loop end-to-end with Bedrock + DDB mocked.
 * Catches the regressions you can't see in the tool-registry tests: tool
 * call cap, history fetching, budget gating, persistence shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    getConversation: vi.fn(async () => []),
    getBudget: vi.fn(async () => ({
      householdId: 'hh-1',
      yearMonth: '2026-07',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
    })),
    // The atomic gate: returns the POST-reservation committed totals. Default to
    // a fresh budget (committed 0 → post-reserve == the reservation).
    reserveBudget: vi.fn(
      async (_hh: string, reserve: { inputTokens: number; outputTokens: number }) => ({
        householdId: 'hh-1',
        yearMonth: '2026-05',
        inputTokens: reserve.inputTokens,
        outputTokens: reserve.outputTokens,
        costUsd: 0,
      })
    ),
    incrementBudget: vi.fn(async () => undefined),
    claimTurn: vi.fn(async () => ({ status: 'claimed' as const })),
    finalizeTurn: vi.fn(async () => undefined),
    releaseTurn: vi.fn(async () => undefined),
  };
});
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');
// Default every test to a paid household so the plan gate doesn't interfere
// with tests that aren't about it; the gate itself gets its own describe
// block below with per-test overrides.
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));

import {
  runChatTurn,
  trimHistory,
  BUDGET_CONFIG,
  GROUNDING_BLOCK_MESSAGE,
  RESERVE_INPUT_TOKENS,
  RESERVE_OUTPUT_TOKENS,
} from '../../../src/services/chat/index.js';
import * as billing from '../../../src/services/billing.js';
import { askSprout, isSproutIntegrationEnabled } from '../../../src/services/sprout.js';
import { invokeChatModel, type BedrockMessage } from '../../../src/services/chat/bedrock.js';
import {
  appendMessage,
  appendMessagePair,
  claimTurn,
  finalizeTurn,
  getConversation,
  incrementBudget,
  releaseTurn,
  reserveBudget,
  ChatBudgetExceededError,
} from '../../../src/services/chat/persistence.js';
import type {
  ChatMessageRecord,
  ToolResultBlock,
  ToolUseBlock,
} from '../../../src/services/chat/types.js';
import * as plantService from '../../../src/services/plantService.js';
import * as climateService from '../../../src/services/climate.js';
import * as householdService from '../../../src/services/householdService.js';
import { searchCorpus } from '../../../src/services/chat/corpus.js';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CHAT_ENABLED;
  vi.mocked(isSproutIntegrationEnabled).mockReturnValue(false);
});

/**
 * Mirrors Bedrock's validation: every assistant tool_use block must be
 * answered by a tool_result with the same id in the immediately-following
 * user message, and every tool_result must reference a tool_use in the
 * immediately-preceding assistant message. Payloads that violate either
 * direction get a ValidationException in production.
 */
function expectValidToolPairing(messages: BedrockMessage[]): void {
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      const toolUseIds = m.content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => b.id);
      if (toolUseIds.length === 0) return;
      const next = messages[i + 1];
      expect(next?.role).toBe('user');
      const resultIds = (next?.content ?? [])
        .filter((b): b is ToolResultBlock => b.type === 'tool_result')
        .map((b) => b.tool_use_id);
      for (const id of toolUseIds) expect(resultIds).toContain(id);
    } else {
      for (const block of m.content) {
        if (block.type !== 'tool_result') continue;
        const prev = messages[i - 1];
        expect(prev?.role).toBe('assistant');
        const useIds = (prev?.content ?? [])
          .filter((b): b is ToolUseBlock => b.type === 'tool_use')
          .map((b) => b.id);
        expect(useIds).toContain(block.tool_use_id);
      }
    }
  });
}

describe('runChatTurn', () => {
  it('stops before any model, budget, or persistence work when the kill switch is off', async () => {
    process.env.CHAT_ENABLED = '0';

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'help my fern' })
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(invokeChatModel).not.toHaveBeenCalled();
  });

  it('uses Sprout without Bedrock and persists citation metadata', async () => {
    vi.mocked(isSproutIntegrationEnabled).mockReturnValueOnce(true);
    vi.mocked(askSprout).mockResolvedValueOnce({
      text: 'Grounded care.',
      citations: [
        {
          title: 'Pothos care',
          url: 'https://example.test/pothos',
          source: 'pothos.md',
          fetch_date: '2026-05-01',
        },
      ],
      observations: [],
      disclosure: 'AI-generated',
    });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'Pothos care?',
      turnId: 'turn-sprout',
    });

    expect(result.provider).toBe('sprout');
    expect(result.budgetRemaining).toEqual({
      inputTokens: BUDGET_CONFIG.maxInputTokensPerMonth - 100,
      outputTokens: BUDGET_CONFIG.maxOutputTokensPerMonth - 20,
    });
    expect(invokeChatModel).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendMessage).mock.calls[1][1].content[1]).toMatchObject({
      type: 'citation',
      source: 'pothos.md',
    });
    expect(finalizeTurn).toHaveBeenCalled();
  });

  it('falls back before persistence when Sprout is unavailable', async () => {
    vi.mocked(isSproutIntegrationEnabled).mockReturnValueOnce(true);
    vi.mocked(askSprout).mockRejectedValueOnce(new Error('sprout unavailable'));
    vi.mocked(invokeChatModel).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Bedrock fallback.' }],
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
    });

    const result = await runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'care?' });

    expect(result.provider).toBe('bedrock');
    expect(invokeChatModel).toHaveBeenCalledOnce();
    expect(appendMessage).toHaveBeenCalledTimes(2);
  });

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
    // Budget reconciled once: the up-front reservation is replaced by actual
    // usage, so the committed delta is (actual - reserved).
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 100 - RESERVE_INPUT_TOKENS,
      outputTokens: 20 - RESERVE_OUTPUT_TOKENS,
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
    // Combined budget reconcile across both Bedrock calls (actual - reserved).
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 450 - RESERVE_INPUT_TOKENS,
      outputTokens: 70 - RESERVE_OUTPUT_TOKENS,
      costUsd: 0.0025,
    });
  });

  it('deduplicates an identical tool call across model iterations', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([]);
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu-repeat-1', name: 'list_household_plants', input: {} },
        ],
        stopReason: 'tool_use',
        inputTokens: 50,
        outputTokens: 10,
        costUsd: 0.0001,
      })
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu-repeat-2', name: 'list_household_plants', input: {} },
        ],
        stopReason: 'tool_use',
        inputTokens: 50,
        outputTokens: 10,
        costUsd: 0.0001,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'You have no plants yet.' }],
        stopReason: 'end_turn',
        inputTokens: 50,
        outputTokens: 10,
        costUsd: 0.0001,
      });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'List my plants.',
    });

    expect(result.assistantText).toBe('You have no plants yet.');
    expect(plantService.getPlants).toHaveBeenCalledTimes(1);
    expect(appendMessagePair).toHaveBeenCalledTimes(2);
    const firstResult = vi.mocked(appendMessagePair).mock.calls[0][2].content[0];
    const secondResult = vi.mocked(appendMessagePair).mock.calls[1][2].content[0];
    expect(firstResult.type).toBe('tool_result');
    expect(secondResult.type).toBe('tool_result');
    if (firstResult.type === 'tool_result' && secondResult.type === 'tool_result') {
      expect(secondResult.content).toBe(firstResult.content);
      expect(secondResult.tool_use_id).not.toBe(firstResult.tool_use_id);
    }
  });

  it('blocks an ungrounded quantitative claim on the live RAG path before persistence', async () => {
    vi.mocked(searchCorpus).mockResolvedValueOnce([
      {
        articleTitle: 'Humidity',
        sectionTitle: 'Tropicals',
        source: 'humidity.md',
        text: 'Calatheas prefer at least 50% humidity.',
        score: 0.92,
      },
    ]);
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu-rag',
            name: 'search_care_knowledge',
            input: { query: 'calathea humidity' },
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.0003,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Keep it at exactly 92% humidity.' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 15,
        costUsd: 0.0004,
      });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'What humidity does a calathea need?',
    });

    expect(result.assistantText).toBe(GROUNDING_BLOCK_MESSAGE);
    const persistedAnswer = vi.mocked(appendMessage).mock.calls.at(-1)?.[1];
    expect(persistedAnswer?.content).toEqual([{ type: 'text', text: GROUNDING_BLOCK_MESSAGE }]);
    expect(JSON.stringify(persistedAnswer)).not.toContain('92%');
  });

  it('accepts a current authoritative tool number when historical RAG keeps the guard active', async () => {
    vi.mocked(getConversation).mockResolvedValueOnce([
      {
        conversationId: 'conv-1',
        timestamp: '2026-07-12T10:00:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'What humidity does a calathea need?' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-07-12T10:00:01.000Z',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-old-rag',
            name: 'search_care_knowledge',
            input: { query: 'calathea humidity' },
          },
        ],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-07-12T10:00:02.000Z',
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-old-rag',
            content: JSON.stringify([
              {
                source: 'humidity.md',
                content: 'Calatheas prefer at least 50% humidity.',
              },
            ]),
          },
        ],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-07-12T10:00:03.000Z',
        role: 'assistant',
        content: [{ type: 'text', text: 'Aim for at least 50% humidity.' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-07-12T10:01:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'What is the current humidity?' }],
      },
    ]);
    vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
      id: 'hh-1',
      name: 'Home',
      location: { city: 'Davis', lat: 38.54, lon: -121.74 },
      createdAt: '2025-01-01',
      createdBy: 'u1',
    });
    vi.mocked(climateService.getWeatherCached).mockResolvedValueOnce({
      observedAt: '2026-07-12T10:00:00.000Z',
      tempC: 24,
      humidity: 42,
      condition: 'Clear',
      description: 'clear sky',
      forecast: [],
    });
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu-climate', name: 'get_household_climate', input: {} }],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.0003,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Current humidity is 42%.' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 15,
        costUsd: 0.0004,
      });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      conversationId: 'conv-1',
      message: 'What is the current humidity?',
    });

    expect(result.assistantText).toBe('Current humidity is 42%.');
    expect(result.assistantText).not.toBe(GROUNDING_BLOCK_MESSAGE);
  });

  it('refuses to invoke Bedrock when the budget reservation is rejected (over cap)', async () => {
    // The atomic gate (reserveBudget) throws when the reservation can't fit.
    vi.mocked(reserveBudget).mockRejectedValueOnce(new ChatBudgetExceededError());

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(vi.mocked(invokeChatModel)).not.toHaveBeenCalled();
    // The reservation never landed, so nothing to reconcile.
    expect(vi.mocked(incrementBudget)).not.toHaveBeenCalled();
  });

  it('rejects with 402 for a free (Seedling) household, before any budget reservation or Bedrock call', async () => {
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(vi.mocked(reserveBudget)).not.toHaveBeenCalled();
    expect(vi.mocked(invokeChatModel)).not.toHaveBeenCalled();
  });

  it.each(['garden', 'greenhouse'])(
    'allows the turn to proceed for a %s household',
    async (planId) => {
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
        planId: planId as 'garden' | 'greenhouse',
      });
      vi.mocked(invokeChatModel).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'hi' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      await expect(
        runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
      ).resolves.toBeDefined();
      expect(vi.mocked(invokeChatModel)).toHaveBeenCalledTimes(1);
    }
  );

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
      expect(firstBlock.content).toBe(
        'Tool result unavailable. Continue with the remaining context.'
      );
    }
  });

  it('builds a valid model payload when history replays a prior tool-using turn', async () => {
    // What getConversation returns on turn TWO of a conversation whose first
    // turn used a tool: user text, assistant tool_use, persisted tool_result,
    // assistant answer, then the just-appended user message for this turn.
    const priorHistory: ChatMessageRecord[] = [
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'list my plants' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:01.000Z',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-prev', name: 'list_household_plants', input: {} }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:01.500Z',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-prev', content: '[]' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:02.000Z',
        role: 'assistant',
        content: [{ type: 'text', text: 'You have no plants yet.' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:05:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'are you sure?' }],
      },
    ];
    vi.mocked(getConversation).mockResolvedValueOnce(priorHistory);
    vi.mocked(invokeChatModel).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Yes — your plant list is empty.' }],
      stopReason: 'end_turn',
      inputTokens: 80,
      outputTokens: 12,
      costUsd: 0.0002,
    });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      conversationId: 'conv-1',
      message: 'are you sure?',
    });

    expect(result.assistantText).toContain('empty');
    const firstCall = vi.mocked(invokeChatModel).mock.calls[0][0];
    expect(firstCall.messages).toHaveLength(5);
    // Tool blocks must survive the DDB round-trip as structured blocks, not
    // flattened text — and every tool_use must have its matching tool_result.
    expect(firstCall.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'tu-prev' });
    expect(firstCall.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu-prev',
    });
    expectValidToolPairing(firstCall.messages);
  });

  it('does not replay a legacy non-JSON tool error into the model', async () => {
    vi.mocked(getConversation).mockResolvedValueOnce([
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'check my plants' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:01.000Z',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-prev', name: 'list_household_plants', input: {} }],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:01.500Z',
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-prev',
            content: 'upstream failed for owner@example.test',
            is_error: true,
          },
        ],
      },
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:05:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'try again' }],
      },
    ]);
    vi.mocked(invokeChatModel).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Please try the plant lookup again.' }],
      stopReason: 'end_turn',
      inputTokens: 80,
      outputTokens: 12,
      costUsd: 0.0002,
    });

    await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      conversationId: 'conv-1',
      message: 'try again',
    });

    const replayed = vi.mocked(invokeChatModel).mock.calls[0][0].messages[2].content[0];
    expect(replayed).toMatchObject({ type: 'tool_result', is_error: true });
    if (replayed.type === 'tool_result') {
      expect(replayed.content).toBe(
        'Tool result unavailable. Continue with the remaining context.'
      );
      expect(replayed.content).not.toContain('owner@example.test');
    }
  });

  it('persists the tool_result turn during a tool-use loop', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([]);
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu-1', name: 'list_household_plants', input: {} }],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.0003,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'No plants yet.' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 15,
        costUsd: 0.0004,
      });

    await runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'list my plants' });

    // The user text and the final assistant answer persist singly; the
    // assistant tool_use turn and its tool_result turn land ATOMICALLY via
    // appendMessagePair, so a half-write can't orphan a tool_use.
    expect(vi.mocked(appendMessage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendMessage).mock.calls.map((c) => c[1].role)).toEqual([
      'user',
      'assistant',
    ]);

    expect(vi.mocked(appendMessagePair)).toHaveBeenCalledTimes(1);
    const [, assistantToolUse, toolResultRecord] = vi.mocked(appendMessagePair).mock.calls[0];
    expect(assistantToolUse.role).toBe('assistant');
    expect(assistantToolUse.content[0]).toMatchObject({ type: 'tool_use', id: 'tu-1' });
    expect(toolResultRecord.role).toBe('user');
    expect(toolResultRecord.conversationId).toBe('conv-1');
    expect(toolResultRecord.content).toHaveLength(1);
    expect(toolResultRecord.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu-1' });
    // The pair preserves write order (assistant before its tool_result).
    expect(toolResultRecord.timestamp >= assistantToolUse.timestamp).toBe(true);

    // What we persisted is exactly what the model saw on the follow-up call.
    const secondCallMessages = vi.mocked(invokeChatModel).mock.calls[1][0].messages;
    expect(secondCallMessages.at(-1)?.content).toEqual(toolResultRecord.content);
    expectValidToolPairing(secondCallMessages);
  });

  it('commits partial token usage when a mid-turn Bedrock call fails', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([]);
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tu-1', name: 'list_household_plants', input: {} }],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.0003,
      })
      // The follow-up call (after the tool ran + cost tokens) throws.
      .mockRejectedValueOnce(new Error('bedrock throttled'));

    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'list my plants' })
    ).rejects.toThrow('bedrock throttled');

    // The first call's tokens are billed even though the turn threw (reconcile
    // = actual - reserved) — otherwise a failed turn is free and the budget
    // never converges. The unused part of the reservation is released.
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 100 - RESERVE_INPUT_TOKENS,
      outputTokens: 10 - RESERVE_OUTPUT_TOKENS,
      costUsd: 0.0003,
    });
  });

  it('releases the whole reservation when the turn fails before consuming tokens', async () => {
    vi.mocked(invokeChatModel).mockRejectedValueOnce(new Error('bedrock down'));
    await expect(runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hi' })).rejects.toThrow(
      'bedrock down'
    );
    // Reservation landed at the gate, then the first call threw → reconcile
    // gives back the full reservation (0 - reserved), netting zero committed.
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: -RESERVE_INPUT_TOKENS,
      outputTokens: -RESERVE_OUTPUT_TOKENS,
      costUsd: 0,
    });
  });

  // --- Turn idempotency (#3) ---

  it('replays a completed turn (idempotency hit) without running or charging again', async () => {
    const stored = {
      conversationId: 'conv-prior',
      assistantText: 'Already answered.',
      proposals: [],
      budgetRemaining: { inputTokens: 123, outputTokens: 45 },
    };
    vi.mocked(claimTurn).mockResolvedValueOnce({ status: 'done', result: stored });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'hi',
      turnId: 'turn-1',
    });

    expect(result).toEqual(stored);
    // Nothing ran: no Bedrock, no reservation, no persistence, no budget write.
    expect(vi.mocked(invokeChatModel)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveBudget)).not.toHaveBeenCalled();
    expect(vi.mocked(appendMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(incrementBudget)).not.toHaveBeenCalled();
  });

  it('rejects with 409 when a prior attempt for the same turnId is still running', async () => {
    vi.mocked(claimTurn).mockResolvedValueOnce({ status: 'in_progress' });
    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hi', turnId: 'turn-2' })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(vi.mocked(invokeChatModel)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveBudget)).not.toHaveBeenCalled();
  });

  it('finalizes the turn record on success (so a retry replays it)', async () => {
    vi.mocked(invokeChatModel).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
    });
    await runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hi', turnId: 'turn-3' });
    expect(vi.mocked(finalizeTurn)).toHaveBeenCalledWith(
      'hh-1',
      'turn-3',
      expect.objectContaining({ assistantText: 'ok' })
    );
    expect(vi.mocked(releaseTurn)).not.toHaveBeenCalled();
  });

  it('releases the turn claim when the turn fails (so the fallback can retry)', async () => {
    vi.mocked(invokeChatModel).mockRejectedValueOnce(new Error('boom'));
    await expect(
      runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hi', turnId: 'turn-4' })
    ).rejects.toThrow('boom');
    expect(vi.mocked(releaseTurn)).toHaveBeenCalledWith('hh-1', 'turn-4');
    expect(vi.mocked(finalizeTurn)).not.toHaveBeenCalled();
  });

  it('exposes propose_reminder_task with the confirm-card contract in the system prompt, and collects validated proposals', async () => {
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Bertha',
      species: 'Monstera',
      location: null,
      imageUrl: null,
      notes: null,
      status: 'active',
      statusChangedAt: null,
      tags: [],
      createdAt: '2025-01-01',
      createdBy: 'u1',
      updatedAt: '2025-01-01',
    });
    vi.mocked(invokeChatModel)
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tu-prop',
            name: 'propose_reminder_task',
            input: { plantId: 'p1', type: 'water', frequencyDays: 7 },
          },
        ],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.0004,
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'I suggested a weekly watering reminder — confirm it on the card.',
          },
        ],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 25,
        costUsd: 0.0005,
      });

    const result = await runChatTurn({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'remind me to water Bertha weekly',
    });

    // The safe-write contract lives in the system prompt: offer proposals,
    // route creation through the card, never claim the task was created.
    const firstCall = vi.mocked(invokeChatModel).mock.calls[0][0];
    expect(firstCall.system).toContain('propose_reminder_task');
    expect(firstCall.system).toMatch(/confirm via the card/i);
    expect(firstCall.system).toMatch(/NEVER say the reminder\/task was\s+created/);
    // ...and the tool itself is in the registry handed to Bedrock.
    expect(firstCall.tools.map((t) => t.name)).toContain('propose_reminder_task');

    // The validated (server-enriched) proposal surfaces on the API result.
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      plantId: 'p1',
      plantName: 'Bertha',
      type: 'water',
      frequencyDays: 7,
    });
    expect(typeof result.proposals[0].proposalId).toBe('string');

    // The persisted tool_result block carries the proposed payload, so a
    // conversation reload can re-render the card from history. It lands via the
    // atomic appendMessagePair (assistant tool_use + tool_result), not a lone
    // appendMessage.
    const toolResultRecord = vi.mocked(appendMessagePair).mock.calls[0][2];
    const toolResultBlock = toolResultRecord.content[0];
    expect(toolResultBlock.type).toBe('tool_result');
    if (toolResultBlock.type === 'tool_result') {
      const parsed = JSON.parse(toolResultBlock.content) as {
        status: string;
        proposal: { plantName: string };
      };
      expect(parsed.status).toBe('proposed');
      expect(parsed.proposal.plantName).toBe('Bertha');
      // The authenticated history keeps confirm-card fields, while the copy
      // sent back to Bedrock is centrally redacted at the model boundary.
      expect(parsed.proposal).toHaveProperty('assignedTo');
    }
    const modelToolResult = vi
      .mocked(invokeChatModel)
      .mock.calls[1][0].messages.at(-1)
      ?.content.find((block) => block.type === 'tool_result');
    expect(modelToolResult?.type).toBe('tool_result');
    if (modelToolResult?.type === 'tool_result') {
      expect(modelToolResult.content).not.toMatch(/assignedTo|assigneeName/);
    }
  });
});

describe('trimHistory', () => {
  it('returns history untouched when within the window', () => {
    const history: ChatMessageRecord[] = [
      {
        conversationId: 'conv-1',
        timestamp: '2026-06-11T10:00:00.000Z',
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      },
    ];
    expect(trimHistory(history)).toBe(history);
  });

  it('never cuts between an assistant tool_use and its tool_result', () => {
    // 28 messages in a repeating [user text, assistant tool_use,
    // user tool_result, assistant text] pattern, then a closing plain
    // user/assistant exchange (30 total). A naive slice(-24) would start the
    // window at index 6 — a tool_result whose tool_use was cut, which
    // Bedrock rejects.
    const stamp = (i: number) => new Date(Date.UTC(2026, 5, 11, 10, 0, i)).toISOString();
    const history: ChatMessageRecord[] = Array.from({ length: 28 }, (_, i): ChatMessageRecord => {
      const base = { conversationId: 'conv-1', timestamp: stamp(i) };
      switch (i % 4) {
        case 0:
          return { ...base, role: 'user', content: [{ type: 'text', text: `q${i}` }] };
        case 1:
          return {
            ...base,
            role: 'assistant',
            content: [
              { type: 'tool_use', id: `tu-${i}`, name: 'list_household_plants', input: {} },
            ],
          };
        case 2:
          return {
            ...base,
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `tu-${i - 1}`, content: '[]' }],
          };
        default:
          return { ...base, role: 'assistant', content: [{ type: 'text', text: `a${i}` }] };
      }
    });
    history.push(
      {
        conversationId: 'conv-1',
        timestamp: stamp(28),
        role: 'user',
        content: [{ type: 'text', text: 'q28' }],
      },
      {
        conversationId: 'conv-1',
        timestamp: stamp(29),
        role: 'assistant',
        content: [{ type: 'text', text: 'a29' }],
      }
    );

    const trimmed = trimHistory(history);
    expect(trimmed.length).toBeLessThanOrEqual(24);
    // The window starts at the next plain user message (index 8), not the
    // orphaned tool_result at index 6 nor the assistant message at 7.
    expect(trimmed).toHaveLength(22);
    expect(trimmed[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'q8' }] });
    expectValidToolPairing(trimmed.map((m) => ({ role: m.role, content: m.content })));
  });
});
