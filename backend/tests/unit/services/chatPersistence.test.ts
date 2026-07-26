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
  appendTurnUserMessage,
  claimTurn,
  finalizeTurn,
  getConversation,
  reserveBudget,
  markTurnRetryable,
  reconcileTurnBudget,
  ChatBudgetExceededError,
  type TurnBudgetReconciliation,
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

  it('atomically records an idempotent user message and its turn pointer', async () => {
    const message: ChatMessageRecord = {
      conversationId: 'c1',
      timestamp: '2026-06-11T12:00:00.000Z',
      role: 'user',
      content: [{ type: 'text', text: 'help my fern' }],
    };
    await appendTurnUserMessage('hh-1', '550e8400-e29b-41d4-a716-446655440000', message);

    const tx = vi
      .mocked(dynamodb.send)
      .mock.calls.map(
        ([command]) =>
          command as unknown as {
            kind: string;
            input: { ClientRequestToken?: string; TransactItems: unknown[] };
          }
      )
      .find((command) => command.kind === 'TransactWrite');
    expect(tx?.input.ClientRequestToken).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(tx?.input.TransactItems).toHaveLength(2);
    expect(tx?.input.TransactItems[0]).toHaveProperty('Put');
    expect(tx?.input.TransactItems[1]).toHaveProperty('Update');
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
    expect(await claimTurn('hh-1', 't1', 'c1')).toEqual({
      status: 'claimed',
      conversationId: 'c1',
      userMessagePersisted: false,
      attemptId: expect.any(String),
    });
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
    const pending: TurnBudgetReconciliation = {
      reconciliationId: 'attempt-prior',
      yearMonth: '2026-07',
      inputTokens: -7990,
      outputTokens: -2043,
      costUsd: 0.0001,
      status: 'pending',
    };
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        status: 'done',
        result: { assistantText: 'cached' },
        budgetReconciliation: pending,
      },
    } as never);
    const claim = await claimTurn('hh-1', 't1', 'c1');
    expect(claim.status).toBe('done');
    expect(claim.result).toEqual({ assistantText: 'cached' });
    expect(claim.budgetReconciliation).toEqual(pending);
  });

  it('reclaims a retryable turn while preserving its conversation/message pointer', async () => {
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(
        Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })
      )
      .mockResolvedValueOnce({
        Item: {
          status: 'retryable',
          conversationId: 'c-existing',
          userMessagePersisted: true,
        },
      } as never)
      .mockResolvedValueOnce({
        Attributes: {
          status: 'in_progress',
          conversationId: 'c-existing',
          userMessagePersisted: true,
        },
      } as never);

    await expect(claimTurn('hh-1', 't-retry', 'c-new')).resolves.toEqual({
      status: 'claimed',
      conversationId: 'c-existing',
      userMessagePersisted: true,
      attemptId: expect.any(String),
    });
  });

  it('marks a failed persisted turn retryable instead of deleting its pointer', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    const reconciliation: TurnBudgetReconciliation = {
      reconciliationId: 'attempt-1',
      yearMonth: '2026-07',
      inputTokens: -7900,
      outputTokens: -2000,
      costUsd: 0.0002,
      status: 'pending',
    };
    await markTurnRetryable('hh-1', 't-failed', 'attempt-1', reconciliation);
    const command = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: {
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(command.kind).toBe('Update');
    expect(command.input.UpdateExpression).toContain(':retryable');
    expect(command.input.UpdateExpression).toContain('budgetReconciliation');
    expect(command.input.ConditionExpression).toContain(':inProgress');
    expect(command.input.ConditionExpression).toContain(':attemptId');
    expect(command.input.ExpressionAttributeValues[':reconciliation']).toEqual(reconciliation);
  });

  it('finalizeTurn atomically records the result and pending reconciliation without replacing the turn row', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    const reconciliation: TurnBudgetReconciliation = {
      reconciliationId: 'attempt-9',
      yearMonth: '2026-07',
      inputTokens: -7990,
      outputTokens: -2043,
      costUsd: 0.0001,
      status: 'pending',
    };
    await finalizeTurn('hh-1', 't9', 'attempt-9', { assistantText: 'done' }, reconciliation);
    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: {
        Key: { SK: string };
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    };
    expect(update.kind).toBe('Update');
    expect(update.input.Key.SK).toBe('CHATTURN#t9');
    expect(update.input.UpdateExpression).toContain('budgetReconciliation');
    expect(update.input.ConditionExpression).toContain('attemptId = :attemptId');
    expect(update.input.ExpressionAttributeValues[':result']).toEqual({ assistantText: 'done' });
    expect(update.input.ExpressionAttributeValues[':reconciliation']).toEqual(reconciliation);
  });

  it('reconciles a turn exactly once with a budget transaction and durable ledger marker', async () => {
    const reconciliation: TurnBudgetReconciliation = {
      reconciliationId: 'attempt-9',
      yearMonth: '2026-06',
      inputTokens: -7990,
      outputTokens: -2043,
      costUsd: 0.0001,
      status: 'pending',
    };
    const committed = { inputTokens: 8000, outputTokens: 2048, costUsd: 0 };
    let ledger: Record<string, unknown> | undefined;
    vi.mocked(dynamodb.send).mockImplementation(async (rawCommand) => {
      const command = rawCommand as unknown as {
        kind: string;
        input: {
          TransactItems?: Array<{
            Update?: { ExpressionAttributeValues: Record<string, number> };
            Put?: { Item: Record<string, unknown> };
          }>;
        };
      };
      if (command.kind === 'TransactWrite') {
        if (ledger) {
          throw Object.assign(new Error('duplicate'), { name: 'TransactionCanceledException' });
        }
        const update = command.input.TransactItems?.[0].Update;
        committed.inputTokens += update?.ExpressionAttributeValues[':in'] ?? 0;
        committed.outputTokens += update?.ExpressionAttributeValues[':out'] ?? 0;
        committed.costUsd += update?.ExpressionAttributeValues[':cost'] ?? 0;
        ledger = command.input.TransactItems?.[1].Put?.Item;
        return {} as never;
      }
      if (command.kind === 'Get') return { Item: ledger } as never;
      // Turn-row pending → applied metadata update.
      return {} as never;
    });

    await reconcileTurnBudget('hh-1', 't9', reconciliation);
    await reconcileTurnBudget('hh-1', 't9', reconciliation);

    // Starting from the reservation, the adjustment landed exactly once even
    // though the same reconciliation was invoked twice.
    expect(committed).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.0001 });
    const transactions = vi
      .mocked(dynamodb.send)
      .mock.calls.map(([command]) => command as unknown as { kind: string; input: unknown })
      .filter((command) => command.kind === 'TransactWrite') as Array<{
      kind: string;
      input: {
        TransactItems: Array<{
          Update?: {
            Key: { SK: string };
            ExpressionAttributeValues: Record<string, unknown>;
          };
          Put?: { Item: Record<string, unknown>; ConditionExpression: string };
        }>;
      };
    }>;
    expect(transactions).toHaveLength(2);
    expect(transactions[0].input.TransactItems[0].Update?.Key.SK).toBe('CHATBUDGET#2026-06');
    expect(transactions[0].input.TransactItems[0].Update?.ExpressionAttributeValues).toMatchObject({
      ':in': -7990,
      ':out': -2043,
      ':cost': 0.0001,
    });
    expect(transactions[0].input.TransactItems[1].Put?.Item).toMatchObject({
      SK: 'CHATBUDGETRECON#attempt-9',
      reconciliationId: 'attempt-9',
    });
    expect(transactions[0].input.TransactItems[1].Put?.ConditionExpression).toBe(
      'attribute_not_exists(PK)'
    );
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
    // Querying newest-first means page 1 holds the just-appended tail; page 2
    // resumes toward older rows. The result is reversed back to chronology.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [item(2)],
        LastEvaluatedKey: { PK: 'HOUSEHOLD#hh-1', SK: 'CHAT#c1#MSG#...' },
      } as never)
      .mockResolvedValueOnce({ Items: [item(1)] } as never);

    const replayed = await getConversation('hh-1', 'c1');

    expect(replayed).toHaveLength(2);
    expect(replayed[1].content).toEqual([{ type: 'text', text: 'msg 2' }]);
    // Second Query must resume from the cursor, not restart.
    const queries = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: Record<string, unknown> })
      .filter((cmd) => cmd.kind === 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[0].input.ScanIndexForward).toBe(false);
    expect(queries[0].input.ExclusiveStartKey).toBeUndefined();
    expect(queries[1].input.ExclusiveStartKey).toEqual({
      PK: 'HOUSEHOLD#hh-1',
      SK: 'CHAT#c1#MSG#...',
    });
  });

  it('keeps the newest tail even when the defensive 10-page cap is reached', async () => {
    const pageItem = (i: number) => ({
      conversationId: 'c1',
      timestamp: new Date(Date.UTC(2026, 5, 11, 12, 0, i)).toISOString(),
      role: 'user',
      content: [{ type: 'text', text: `msg ${i}` }],
    });
    // DynamoDB returns descending pages: 10 is newest, 1 is oldest among the
    // bounded window. Every page advertises another cursor; the implementation
    // must stop at 10 without ever dropping page 1 (the actual conversation
    // tail) and return the collected window chronologically.
    for (let i = 10; i >= 1; i -= 1) {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [pageItem(i)],
        LastEvaluatedKey: { PK: 'HOUSEHOLD#hh-1', SK: `cursor-${i}` },
      } as never);
    }

    const replayed = await getConversation('hh-1', 'c1');

    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(10);
    expect(replayed).toHaveLength(10);
    expect(replayed[0].content).toEqual([{ type: 'text', text: 'msg 1' }]);
    expect(replayed.at(-1)?.content).toEqual([{ type: 'text', text: 'msg 10' }]);
  });
});
