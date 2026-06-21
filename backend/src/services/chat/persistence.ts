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
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import type { BudgetConfig, BudgetState, ChatMessageRecord } from './types.js';

const CONVERSATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const BUDGET_TTL_SECONDS = 95 * 24 * 60 * 60;

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

export async function appendMessage(
  householdId: string,
  message: ChatMessageRecord
): Promise<void> {
  const seq = await nextConversationSeq(householdId, message.conversationId);
  // 12 digits orders correctly past any realistic per-conversation message
  // count. The `#SEQ` counter row's SK never matches the `#MSG#` prefix, so
  // getConversation's begins_with query excludes it.
  const sk = `CHAT#${message.conversationId}#MSG#${message.timestamp}#${String(seq).padStart(12, '0')}`;
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: sk,
        entityType: 'ChatMessage',
        ...message,
        ttl: Math.floor(Date.now() / 1000) + CONVERSATION_TTL_SECONDS,
      },
    })
  );
}

export async function getConversation(
  householdId: string,
  conversationId: string
): Promise<ChatMessageRecord[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': `CHAT#${conversationId}#MSG#`,
      },
    })
  );
  return (result.Items ?? []).map((item) => ({
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
