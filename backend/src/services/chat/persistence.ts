/**
 * DDB-backed persistence for chat conversations + the per-household monthly
 * token budget.
 *
 * Schema:
 *   - Messages: PK=HOUSEHOLD#<id>, SK=CHAT#<conversationId>#MSG#<isoTimestamp>
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

export async function appendMessage(
  householdId: string,
  message: ChatMessageRecord
): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `CHAT#${message.conversationId}#MSG#${message.timestamp}`,
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
