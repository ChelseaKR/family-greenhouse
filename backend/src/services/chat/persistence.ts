/**
 * DDB-backed persistence for chat conversations + the per-household monthly
 * token budget.
 *
 * Schema:
 *   - Messages: PK=HOUSEHOLD#<id>,
 *               SK=CHAT#<conversationId>#MSG#<isoTimestamp>#<seq><rand>
 *   - Budget:   PK=HOUSEHOLD#<id>, SK=CHATBUDGET#<YYYY-MM>
 *
 * Both rows carry a `ttl` so they auto-expire (30 days for messages, ~95
 * days for budgets — long enough for forensics, short enough not to grow
 * unbounded).
 */
import { v4 as uuid } from 'uuid';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import type { BudgetConfig, BudgetState, ChatMessageRecord } from './types.js';

const CONVERSATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const BUDGET_TTL_SECONDS = 95 * 24 * 60 * 60;
// A turn idempotency record outlives any realistic stream→sync fallback retry
// window, then DynamoDB TTL sweeps it.
const TURN_TTL_SECONDS = 10 * 60;

/**
 * Thrown by reserveBudget when the household is at/over its monthly cap. Call
 * sites map it to the 429 response (checked by `err.name`, like the other
 * service errors, so test automocks stay compatible).
 */
export class ChatBudgetExceededError extends Error {
  constructor() {
    super("You've used this month's chat allowance.");
    this.name = 'ChatBudgetExceededError';
  }
}

export function newConversationId(): string {
  return uuid();
}

function yearMonth(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

// Tool turns write several messages back-to-back, often within the same
// millisecond, so the SK needs a tie-breaker that preserves write order.
//
// A per-PROCESS counter (the previous approach) could not: two concurrent
// turns on the SAME conversation, served by different Lambda containers in the
// same millisecond, each counted from their own independent base, so the
// merged SK order was effectively random at the tie-break level — which could
// interleave a tool_use and its tool_result and make the replayed history
// invalid (Bedrock rejects a tool_use not immediately followed by its result).
//
// Instead, draw a CONVERSATION-scoped monotonic sequence from a DynamoDB
// atomic counter: every message gets a globally ordered position within its
// conversation regardless of which container wrote it. The timestamp still
// leads the SK for readability and the `begins_with` prefix query; the
// zero-padded sequence is the authoritative tie-breaker.
async function nextConversationSeq(householdId: string, conversationId: string): Promise<number> {
  const res = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `CHAT#${conversationId}#SEQ` },
      // SET-then-ADD is one valid UpdateExpression; ADD on a missing attribute
      // starts from 0, so the first message gets seq 1.
      UpdateExpression: 'SET entityType = :et, #ttl = :ttl ADD #seq :one',
      ExpressionAttributeNames: { '#seq': 'seq', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':et': 'ChatSeq',
        ':ttl': Math.floor(Date.now() / 1000) + CONVERSATION_TTL_SECONDS,
      },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return (res.Attributes?.seq as number | undefined) ?? 0;
}

/** DynamoDB item for a chat message at sequence `seq`. */
function messageItem(householdId: string, message: ChatMessageRecord, seq: number) {
  // 12 digits orders correctly past any realistic per-conversation message
  // count. The `#SEQ` counter row's SK never matches the `#MSG#` prefix, so
  // getConversation's begins_with query excludes it.
  const sk = `CHAT#${message.conversationId}#MSG#${message.timestamp}#${String(seq).padStart(12, '0')}`;
  return {
    PK: `HOUSEHOLD#${householdId}`,
    SK: sk,
    entityType: 'ChatMessage',
    ...message,
    ttl: Math.floor(Date.now() / 1000) + CONVERSATION_TTL_SECONDS,
  };
}

export async function appendMessage(
  householdId: string,
  message: ChatMessageRecord
): Promise<void> {
  const seq = await nextConversationSeq(householdId, message.conversationId);
  await dynamodb.send(
    new PutCommand({ TableName: TABLE_NAME, Item: messageItem(householdId, message, seq) })
  );
}

/**
 * Append two messages ATOMICALLY (one TransactWrite).
 *
 * Used for an assistant tool_use turn + its answering tool_result turn: the
 * two must land together or not at all. If they were written as two separate
 * Puts and the second failed (process death, throttling), the conversation
 * would hold an assistant tool_use with no matching tool_result — which
 * Bedrock rejects with a ValidationException on EVERY subsequent replay,
 * permanently breaking the conversation. The transaction makes that orphan
 * impossible: a failure leaves neither row, and the user simply resends.
 */
export async function appendMessagePair(
  householdId: string,
  first: ChatMessageRecord,
  second: ChatMessageRecord
): Promise<void> {
  const seq1 = await nextConversationSeq(householdId, first.conversationId);
  const seq2 = await nextConversationSeq(householdId, second.conversationId);
  await dynamodb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: messageItem(householdId, first, seq1) } },
        { Put: { TableName: TABLE_NAME, Item: messageItem(householdId, second, seq2) } },
      ],
    })
  );
}

// Follow-the-cursor page cap for getConversation. A Query returns at most
// 1 MB per page; without following LastEvaluatedKey a long conversation
// silently loses messages at the page boundary. Query newest-first so even if
// the defensive page cap is reached we retain the just-appended current turn,
// then reverse the collected rows back into chronological order for callers.
// Capped so a pathological conversation can't loop unbounded; 10 pages ≈
// 10 MB comfortably exceeds normal 30-day-TTL usage.
const MAX_CONVERSATION_PAGES = 10;

export async function getConversation(
  householdId: string,
  conversationId: string
): Promise<ChatMessageRecord[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}`,
          ':sk': `CHAT#${conversationId}#MSG#`,
        },
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (exclusiveStartKey && pages < MAX_CONVERSATION_PAGES);
  return items.reverse().map((item) => ({
    conversationId: item.conversationId as string,
    timestamp: item.timestamp as string,
    role: item.role as ChatMessageRecord['role'],
    content: item.content as ChatMessageRecord['content'],
    inputTokens: item.inputTokens as number | undefined,
    outputTokens: item.outputTokens as number | undefined,
    costUsd: item.costUsd as number | undefined,
  }));
}

export async function getBudget(householdId: string): Promise<BudgetState> {
  const ym = yearMonth();
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `CHATBUDGET#${ym}`,
      },
    })
  );
  if (!result.Item) {
    return {
      householdId,
      yearMonth: ym,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
  return {
    householdId,
    yearMonth: ym,
    inputTokens: result.Item.inputTokens as number,
    outputTokens: result.Item.outputTokens as number,
    costUsd: result.Item.costUsd as number,
  };
}

export async function incrementBudget(
  householdId: string,
  delta: { inputTokens: number; outputTokens: number; costUsd: number }
): Promise<void> {
  const ym = yearMonth();
  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `CHATBUDGET#${ym}`,
      },
      UpdateExpression:
        'ADD inputTokens :in, outputTokens :out, costUsd :cost SET #t = if_not_exists(#t, :ttl), entityType = if_not_exists(entityType, :etype)',
      ExpressionAttributeNames: {
        '#t': 'ttl',
      },
      ExpressionAttributeValues: {
        ':in': delta.inputTokens,
        ':out': delta.outputTokens,
        ':cost': delta.costUsd,
        ':ttl': Math.floor(Date.now() / 1000) + BUDGET_TTL_SECONDS,
        ':etype': 'ChatBudget',
      },
    })
  );
}

export function isOverBudget(state: BudgetState, config: BudgetConfig): boolean {
  return (
    state.inputTokens >= config.maxInputTokensPerMonth ||
    state.outputTokens >= config.maxOutputTokensPerMonth
  );
}

/**
 * ATOMICALLY reserve `reserve` tokens against the monthly cap — the budget
 * gate. Unlike a read-then-check-then-increment (which lets two concurrent
 * turns both pass when near the cap), this is a single conditional UPDATE:
 * DynamoDB serializes it, so the second concurrent turn's condition fails and
 * it's rejected instead of overshooting. Returns the post-reservation committed
 * totals (UPDATED_NEW) so the caller can derive remaining; the reservation is
 * reconciled to ACTUAL usage by incrementBudget once the turn finishes.
 *
 * The reserve is a modest representative-turn estimate (not worst case), so the
 * gate stays atomic for the common case without 429-ing users who still have
 * budget. A turn that hard-crashes (Lambda kill) before reconciling leaks its
 * reservation until the month resets — bounded and rare; this is a soft
 * cost-control limit, not a hard billing stop.
 *
 * Throws ChatBudgetExceededError when the reservation can't fit under the cap.
 */
export async function reserveBudget(
  householdId: string,
  reserve: { inputTokens: number; outputTokens: number },
  config: BudgetConfig
): Promise<BudgetState> {
  const ym = yearMonth();
  try {
    const res = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `CHATBUDGET#${ym}` },
        UpdateExpression:
          'ADD inputTokens :rin, outputTokens :rout SET #t = if_not_exists(#t, :ttl), entityType = if_not_exists(entityType, :etype)',
        // Allow the reservation only if BOTH counters still leave room for it
        // (committed <= cap - reserve). Absent counters start at 0 → allowed.
        ConditionExpression:
          '(attribute_not_exists(inputTokens) OR inputTokens <= :inThreshold) AND (attribute_not_exists(outputTokens) OR outputTokens <= :outThreshold)',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: {
          ':rin': reserve.inputTokens,
          ':rout': reserve.outputTokens,
          ':inThreshold': config.maxInputTokensPerMonth - reserve.inputTokens,
          ':outThreshold': config.maxOutputTokensPerMonth - reserve.outputTokens,
          ':ttl': Math.floor(Date.now() / 1000) + BUDGET_TTL_SECONDS,
          ':etype': 'ChatBudget',
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    return {
      householdId,
      yearMonth: ym,
      inputTokens: res.Attributes?.inputTokens as number,
      outputTokens: res.Attributes?.outputTokens as number,
      costUsd: (res.Attributes?.costUsd as number) ?? 0,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new ChatBudgetExceededError();
    }
    throw err;
  }
}

/**
 * Result of claiming a turn's idempotency slot.
 *   - 'claimed'     → we won; run the turn.
 *   - 'done'        → a prior attempt finished; `result` is its stored output.
 *   - 'in_progress' → a prior attempt is still running (rare race).
 */
export interface TurnClaim {
  status: 'claimed' | 'done' | 'in_progress';
  result?: Record<string, unknown>;
}

/**
 * Claim a per-turn idempotency slot keyed by a client-supplied turnId. The
 * conditional Put makes the first caller the owner; a later caller with the
 * SAME turnId (e.g. a stream that completed server-side but whose client fell
 * back to the sync endpoint) gets the stored result back instead of running —
 * and charging — a duplicate turn.
 */
export async function claimTurn(householdId: string, turnId: string): Promise<TurnClaim> {
  const key = { PK: `HOUSEHOLD#${householdId}`, SK: `CHATTURN#${turnId}` };
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...key,
          entityType: 'ChatTurn',
          status: 'in_progress',
          ttl: Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return { status: 'claimed' };
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    const existing = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
    if (existing.Item?.status === 'done') {
      return { status: 'done', result: existing.Item.result as Record<string, unknown> };
    }
    return { status: 'in_progress' };
  }
}

/** Record a completed turn's result so a same-turnId retry replays it. */
export async function finalizeTurn(
  householdId: string,
  turnId: string,
  result: Record<string, unknown>
): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `CHATTURN#${turnId}`,
        entityType: 'ChatTurn',
        status: 'done',
        result,
        ttl: Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS,
      },
    })
  );
}

/** Release a claimed-but-failed turn so a legitimate retry can run it fresh. */
export async function releaseTurn(householdId: string, turnId: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `CHATTURN#${turnId}` },
    })
  );
}
