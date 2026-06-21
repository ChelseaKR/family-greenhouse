/**
 * streamChatTurn orchestration: mocked Bedrock stream → ordered events out
 * (start → deltas → tool events → done), with the SAME persistence semantics
 * as the sync path — only completed messages hit DDB, deltas are
 * transport-only, budget is incremented once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/chat/bedrock.js');
vi.mock('../../../src/services/chat/persistence.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/chat/persistence.js')>(
    '../../../src/services/chat/persistence.js'
  );
  return {
    ...actual,
    newConversationId: vi.fn(() => 'conv-stream-1'),
    appendMessage: vi.fn(async () => undefined),
    appendMessagePair: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => []),
    getBudget: vi.fn(async () => ({
      householdId: 'hh-1',
      yearMonth: '2026-06',
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

import { streamChatTurn, type ChatStreamEvent } from '../../../src/services/chat/index.js';
import {
  invokeChatModel,
  invokeChatModelStream,
  type BedrockChatResponse,
  type BedrockStreamDelta,
} from '../../../src/services/chat/bedrock.js';
import {
  appendMessage,
  appendMessagePair,
  incrementBudget,
} from '../../../src/services/chat/persistence.js';
import * as plantService from '../../../src/services/plantService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a mocked Bedrock stream: yields the deltas, returns the response. */
function mockedStream(
  deltas: string[],
  response: BedrockChatResponse
): AsyncGenerator<BedrockStreamDelta, BedrockChatResponse> {
  return (async function* () {
    for (const text of deltas) yield { type: 'text_delta' as const, text };
    return response;
  })();
}

async function collect(input: Parameters<typeof streamChatTurn>[0]): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  const gen = streamChatTurn(input);
  for (;;) {
    const next = await gen.next();
    if (next.done) break;
    events.push(next.value);
  }
  return events;
}

describe('streamChatTurn', () => {
  it('yields start → ordered deltas → done, and persists only the completed messages', async () => {
    vi.mocked(invokeChatModelStream).mockReturnValueOnce(
      mockedStream(['You have ', 'no plants ', 'yet.'], {
        content: [{ type: 'text', text: 'You have no plants yet.' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.0006,
      })
    );

    const events = await collect({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'what plants do I have?',
    });

    expect(events[0]).toEqual({ type: 'start', conversationId: 'conv-stream-1' });
    const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
    expect(deltas).toEqual(['You have ', 'no plants ', 'yet.']);

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.result.conversationId).toBe('conv-stream-1');
      expect(done.result.assistantText).toBe('You have no plants yet.');
      expect(done.result.proposals).toEqual([]);
    }

    // Persistence identical to the sync path: user turn + assistant turn,
    // both as completed messages (no delta fragments in DDB).
    expect(vi.mocked(appendMessage)).toHaveBeenCalledTimes(2);
    const records = vi.mocked(appendMessage).mock.calls.map((c) => c[1]);
    expect(records[0].role).toBe('user');
    expect(records[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'You have no plants yet.' }],
    });
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(incrementBudget)).toHaveBeenCalledWith('hh-1', {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0006,
    });
    // The streaming path never touches the sync Bedrock operation.
    expect(vi.mocked(invokeChatModel)).not.toHaveBeenCalled();
  });

  it('runs the tool loop with tool_start + proposal events interleaved in order', async () => {
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
    vi.mocked(invokeChatModelStream)
      .mockReturnValueOnce(
        mockedStream(['Let me set that up.'], {
          content: [
            { type: 'text', text: 'Let me set that up.' },
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'propose_reminder_task',
              input: { plantId: 'p1', type: 'water', frequencyDays: 7 },
            },
          ],
          stopReason: 'tool_use',
          inputTokens: 150,
          outputTokens: 40,
          costUsd: 0.001,
        })
      )
      .mockReturnValueOnce(
        mockedStream(['Confirm the card to create it.'], {
          content: [{ type: 'text', text: 'Confirm the card to create it.' }],
          stopReason: 'end_turn',
          inputTokens: 180,
          outputTokens: 30,
          costUsd: 0.0011,
        })
      );

    const events = await collect({
      userId: 'u1',
      householdId: 'hh-1',
      message: 'remind me to water Bertha weekly',
    });

    // Event ORDER is the contract the SSE client renders from.
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual([
      'start',
      'delta', // "Let me set that up."
      'delta', // paragraph separator before the post-tool text
      'tool_start',
      'proposal',
      'delta', // "Confirm the card to create it."
      'done',
    ]);

    const toolStart = events.find((e) => e.type === 'tool_start');
    if (toolStart?.type === 'tool_start') expect(toolStart.name).toBe('propose_reminder_task');

    const proposalEvent = events.find((e) => e.type === 'proposal');
    expect(proposalEvent?.type).toBe('proposal');
    if (proposalEvent?.type === 'proposal') {
      expect(proposalEvent.proposal).toMatchObject({
        plantId: 'p1',
        plantName: 'Bertha',
        type: 'water',
        frequencyDays: 7,
      });
    }

    const done = events.at(-1);
    if (done?.type === 'done') {
      expect(done.result.proposals).toHaveLength(1);
      expect(done.result.assistantText).toBe('Confirm the card to create it.');
    }

    // Exactly the sync path's persistence: user text + final assistant via
    // appendMessage, and the assistant tool_use + tool_result pair landed
    // atomically via appendMessagePair, with budget rolled up once.
    const roles = vi.mocked(appendMessage).mock.calls.map((c) => c[1].role);
    expect(roles).toEqual(['user', 'assistant']);
    const pairRoles = vi
      .mocked(appendMessagePair)
      .mock.calls[0].slice(1)
      .map((r) => r.role);
    expect(pairRoles).toEqual(['assistant', 'user']);
    const [budgetHousehold, budgetDelta] = vi.mocked(incrementBudget).mock.calls[0];
    expect(budgetHousehold).toBe('hh-1');
    expect(budgetDelta.inputTokens).toBe(330);
    expect(budgetDelta.outputTokens).toBe(70);
    expect(budgetDelta.costUsd).toBeCloseTo(0.0021, 10);
  });

  it('still gates on the budget before any Bedrock call', async () => {
    const persistence = await import('../../../src/services/chat/persistence.js');
    vi.mocked(persistence.getBudget).mockResolvedValueOnce({
      householdId: 'hh-1',
      yearMonth: '2026-06',
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      costUsd: 99,
    });

    await expect(
      collect({ userId: 'u1', householdId: 'hh-1', message: 'hello' })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(vi.mocked(invokeChatModelStream)).not.toHaveBeenCalled();
    expect(vi.mocked(appendMessage)).not.toHaveBeenCalled();
  });
});
