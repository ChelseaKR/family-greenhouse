/**
 * Exercises the real chat persistence layer with the DDB client mocked.
 * Guards two storage invariants the chatTurn tests can't see (they mock the
 * whole persistence module):
 *
 *   1. Same-millisecond writes get distinct SKs (tool turns write the
 *      assistant tool_use + the tool_result back-to-back), and SK
 *      lexicographic order still matches write order.
 *   2. tool_use / tool_result content blocks round-trip structurally
 *      through appendMessage → getConversation, so replayed history feeds
 *      Bedrock valid blocks rather than mangled text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
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

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: {
    send: vi.fn(),
  },
  TABLE_NAME: 'test-table',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import {
  appendMessage,
  appendMessagePair,
  claimTurn,
  finalizeTurn,
  getConversation,
  reserveBudget,
  ChatBudgetExceededError,
} from '../../../src/services/chat/persistence.js';
import type { ChatMessageRecord } from '../../../src/services/chat/types.js';

type CapturedCmd = { kind: string; input: { Item: Record<string, unknown> & { SK: string } } };

// appendMessage now issues an atomic-counter UpdateCommand before the message
// PutCommand, so filter to the Put (message) writes.
function sentItems(): CapturedCmd['input']['Item'][] {
  return vi
    .mocked(dynamodb.send)
    .mock.calls.map((c) => c[0] as unknown as CapturedCmd)
    .filter((cmd) => cmd.kind === 'Put')
    .map((cmd) => cmd.input.Item);
}

// Default send mock: the conversation-seq UpdateCommand returns a monotonically
// increasing seq; message PutCommands resolve empty.
function mockSendWithSeq(): void {
  let seq = 0;
  vi.mocked(dynamodb.send).mockImplementation(
    (cmd) =>
      Promise.resolve(
        (cmd as unknown as CapturedCmd).kind === 'Update' ? { Attributes: { seq: ++seq } } : {}
      ) as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendWithSeq();
});

describe('chat message persistence', () => {
  it('appendMessagePair writes both turns in ONE TransactWrite with ordered seqs', async () => {
    const ts = '2026-06-11T12:00:00.000Z';
    await appendMessagePair(
      'hh-1',
      {
        conversationId: 'c1',
        timestamp: ts,
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'list_household_plants', input: {} }],
      },
      {
        conversationId: 'c1',
        timestamp: ts,
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '[]' }],
      }
    );

    const tx = vi
      .mocked(dynamodb.send)
      .mock.calls.map(
        (c) => c[0] as unknown as { kind: string; input: { TransactItems: unknown[] } }
      )
      .find((c) => c.kind === 'TransactWrite');
    expect(tx).toBeDefined();
    const items = (tx!.input.TransactItems as Array<{ Put: { Item: Record<string, string> } }>).map(
      (t) => t.Put.Item
    );
    // Both writes ride the single transaction → no half-written orphan possible.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.role)).toEqual(['assistant', 'user']);
    // The seq tie-breaker keeps the assistant tool_use ahead of its result.
    expect(items[0].SK < items[1].SK).toBe(true);
  });

  it('reserveBudget gates via a conditional ADD at (cap - reserve), mapping a failed condition to ChatBudgetExceededError', async () => {
    const config = { maxInputTokensPerMonth: 250000, maxOutputTokensPerMonth: 50000 };
    // Success: returns the post-reservation committed totals.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: { inputTokens: 8000, outputTokens: 2048 },
    } as never);
    const state = await reserveBudget('hh-1', { inputTokens: 8000, outputTokens: 2048 }, config);
    expect(state.inputTokens).toBe(8000);

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, number> };
    };
    expect(cmd.kind).toBe('Update');
    // The condition leaves room for the reservation: committed <= cap - reserve.
    expect(cmd.input.ExpressionAttributeValues[':inThreshold']).toBe(250000 - 8000);
    expect(cmd.input.ExpressionAttributeValues[':outThreshold']).toBe(50000 - 2048);
    expect(cmd.input.ConditionExpression).toContain('inputTokens <= :inThreshold');

    // Over cap → the conditional write fails → ChatBudgetExceededError.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })
    );
    await expect(
      reserveBudget('hh-1', { inputTokens: 8000, outputTokens: 2048 }, config)
    ).rejects.toBeInstanceOf(ChatBudgetExceededError);
  });

  it('claimTurn wins with a conditional Put, then replays a prior done result on a lost claim', async () => {
    // Win: the attribute_not_exists Put succeeds.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    expect(await claimTurn('hh-1', 't1')).toEqual({ status: 'claimed' });
    const put = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { ConditionExpression: string };
    };
    expect(put.kind).toBe('Put');
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(PK)');

    // Lost claim → read the existing 'done' row → return its stored result.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })
    );
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { status: 'done', result: { assistantText: 'cached' } },
    } as never);
    const claim = await claimTurn('hh-1', 't1');
    expect(claim.status).toBe('done');
    expect(claim.result).toEqual({ assistantText: 'cached' });
  });

  it('finalizeTurn records the completed result keyed by turnId', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    await finalizeTurn('hh-1', 't9', { assistantText: 'done' });
    const put = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: { SK: string; status: string; result: Record<string, unknown> } };
    };
    expect(put.input.Item.SK).toBe('CHATTURN#t9');
    expect(put.input.Item.status).toBe('done');
    expect(put.input.Item.result).toEqual({ assistantText: 'done' });
  });

  it('writes same-millisecond messages under distinct SKs that preserve write order', async () => {
    // beforeEach feeds the conversation-seq UpdateCommand a monotonic value.
    const ts = '2026-06-11T12:00:00.000Z';
    const mk = (
      role: ChatMessageRecord['role'],
      content: ChatMessageRecord['content']
    ): ChatMessageRecord => ({ conversationId: 'c1', timestamp: ts, role, content });

    // A tool turn: three messages written within the same millisecond.
    await appendMessage('hh-1', mk('user', [{ type: 'text', text: 'list my plants' }]));
    await appendMessage(
      'hh-1',
      mk('assistant', [{ type: 'tool_use', id: 'tu-1', name: 'list_household_plants', input: {} }])
    );
    await appendMessage(
      'hh-1',
      mk('user', [{ type: 'tool_result', tool_use_id: 'tu-1', content: '[]' }])
    );

    const sks = sentItems().map((item) => item.SK);
    // No overwrites: every write has a unique SK.
    expect(new Set(sks).size).toBe(3);
    // SK lexicographic order (DDB query order) == write order.
    expect([...sks].sort()).toEqual(sks);
    // Still matched by getConversation's begins_with prefix, timestamp first.
    for (const sk of sks) {
      expect(sk.startsWith(`CHAT#c1#MSG#${ts}#`)).toBe(true);
    }
  });

  it('draws the SK tie-breaker from an atomic per-conversation counter (cross-container safe)', async () => {
    // The sequence comes from DynamoDB (ADD on CHAT#<conv>#SEQ), not a
    // per-process counter, so concurrent turns from different Lambda containers
    // on the same conversation share one globally-ordered sequence.
    await appendMessage('hh-1', {
      conversationId: 'c9',
      timestamp: '2026-06-11T12:00:00.000Z',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });

    const update = vi
      .mocked(dynamodb.send)
      .mock.calls.map(
        (c) =>
          c[0] as unknown as {
            kind: string;
            input: {
              Key: { SK: string };
              UpdateExpression: string;
              ReturnValues: string;
            };
          }
      )
      .find((c) => c.kind === 'Update');
    expect(update).toBeDefined();
    expect(update!.input.Key.SK).toBe('CHAT#c9#SEQ');
    expect(update!.input.UpdateExpression).toContain('ADD #seq :one');
    expect(update!.input.ReturnValues).toBe('UPDATED_NEW');
    // The message SK embeds the returned seq (1), zero-padded to 12 digits.
    expect(sentItems()[0].SK).toBe('CHAT#c9#MSG#2026-06-11T12:00:00.000Z#000000000001');
  });

  it('round-trips tool_result content blocks through appendMessage → getConversation', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    const record: ChatMessageRecord = {
      conversationId: 'c1',
      timestamp: '2026-06-11T12:00:00.000Z',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-1', content: '{"plants":[]}', is_error: false },
      ],
    };
    await appendMessage('hh-1', record);

    const putItem = sentItems()[0];
    // Blocks are stored structurally (DocumentClient marshals the nested
    // maps), not stringified.
    expect(putItem.content).toEqual(record.content);
    expect(putItem.role).toBe('user');

    // Feed the stored item back through getConversation: content must come
    // out block-for-block identical.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [putItem] } as never);
    const replayed = await getConversation('hh-1', 'c1');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].role).toBe('user');
    expect(replayed[0].content).toEqual(record.content);
    expect(replayed[0].conversationId).toBe('c1');
  });

  it('round-trips assistant tool_use blocks with structured input', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    const record: ChatMessageRecord = {
      conversationId: 'c1',
      timestamp: '2026-06-11T12:00:00.500Z',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'tu-2',
          name: 'propose_reminder_task',
          input: { plantId: 'p1', type: 'water', frequencyDays: 7 },
        },
      ],
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.0002,
    };
    await appendMessage('hh-1', record);

    const putItem = sentItems()[0];
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [putItem] } as never);
    const replayed = await getConversation('hh-1', 'c1');
    expect(replayed[0].content).toEqual(record.content);
    expect(replayed[0].inputTokens).toBe(100);
  });

  it('round-trips a propose_reminder_task proposal tool_result so reloads can re-render the card', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    // Exactly what the orchestrator persists: the executor's result,
    // JSON-stringified into the tool_result block's content.
    const proposalPayload = {
      status: 'proposed',
      proposal: {
        proposalId: 'prop-123',
        plantId: 'p1',
        plantName: 'Bertha',
        type: 'water',
        customType: null,
        frequencyDays: 7,
        assignedTo: 'member-1',
        assigneeName: 'Chelsea',
        note: null,
        rationale: 'tropicals like weekly water',
      },
    };
    const record: ChatMessageRecord = {
      conversationId: 'c1',
      timestamp: '2026-06-11T12:00:01.000Z',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-3', content: JSON.stringify(proposalPayload) },
      ],
    };
    await appendMessage('hh-1', record);

    const putItem = sentItems()[0];
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [putItem] } as never);
    const replayed = await getConversation('hh-1', 'c1');

    expect(replayed[0].content).toEqual(record.content);
    const block = replayed[0].content[0];
    expect(block.type).toBe('tool_result');
    if (block.type === 'tool_result') {
      // The GET conversation handler returns content verbatim, so this parse
      // is exactly what the frontend does to rebuild the proposal card.
      const parsed = JSON.parse(block.content) as typeof proposalPayload;
      expect(parsed.status).toBe('proposed');
      expect(parsed.proposal).toEqual(proposalPayload.proposal);
    }
  });

  it('follows LastEvaluatedKey so a >1MB conversation keeps its newest messages', async () => {
    const item = (i: number) => ({
      conversationId: 'c1',
      timestamp: `2026-06-11T12:00:0${i}.000Z`,
      role: 'user',
      content: [{ type: 'text', text: `msg ${i}` }],
    });
    // Page 1 signals truncation via LastEvaluatedKey; page 2 holds the
    // newest message. Before the pagination fix, msg 2 was silently dropped
    // — including the just-appended current user turn.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [item(1)],
        LastEvaluatedKey: { PK: 'HOUSEHOLD#hh-1', SK: 'CHAT#c1#MSG#...' },
      } as never)
      .mockResolvedValueOnce({ Items: [item(2)] } as never);

    const replayed = await getConversation('hh-1', 'c1');

    expect(replayed).toHaveLength(2);
    expect(replayed[1].content).toEqual([{ type: 'text', text: 'msg 2' }]);
    // Second Query must resume from the cursor, not restart.
    const queries = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: Record<string, unknown> })
      .filter((cmd) => cmd.kind === 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[0].input.ExclusiveStartKey).toBeUndefined();
    expect(queries[1].input.ExclusiveStartKey).toEqual({
      PK: 'HOUSEHOLD#hh-1',
      SK: 'CHAT#c1#MSG#...',
    });
  });
});
