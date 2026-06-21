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
    appendMessagePair: vi.fn(async () => undefined),
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

import { runChatTurn, trimHistory, BUDGET_CONFIG } from '../../../src/services/chat/index.js';
import { invokeChatModel, type BedrockMessage } from '../../../src/services/chat/bedrock.js';
import {
  appendMessage,
  appendMessagePair,
  getBudget,
  getConversation,
  incrementBudget,
} from '../../../src/services/chat/persistence.js';
import type {
  ChatMessageRecord,
  ToolResultBlock,
  ToolUseBlock,
} from '../../../src/services/chat/types.js';
import * as plantService from '../../../src/services/plantService.js';

beforeEach(() => {
  vi.clearAllMocks();
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

    // The first call's tokens are billed even though the turn threw — otherwise
    // a failed turn is free and the monthly budget never converges.
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.0003,
    });
  });

  it('does not write the budget when the turn fails before any Bedrock call', async () => {
    vi.mocked(invokeChatModel).mockRejectedValueOnce(new Error('bedrock down'));
    await expect(runChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'hi' })).rejects.toThrow(
      'bedrock down'
    );
    // No tokens consumed → no zero-write.
    expect(vi.mocked(incrementBudget)).not.toHaveBeenCalled();
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
