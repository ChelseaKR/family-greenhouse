import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

const REPORT_TTL_SECONDS = 90 * 24 * 60 * 60;

export type ChatReportReason = 'incorrect' | 'unsafe' | 'offensive' | 'other';

export async function saveChatReport(input: {
  userId: string;
  householdId: string;
  conversationId: string;
  responseText: string;
  reason: ChatReportReason;
  details?: string;
}): Promise<string> {
  const reportId = uuid();
  const createdAt = new Date().toISOString();
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${input.householdId}`,
        SK: `CHATREPORT#${createdAt}#${reportId}`,
        entityType: 'ChatReport',
        reportId,
        householdId: input.householdId,
        userId: input.userId,
        conversationId: input.conversationId,
        responseText: input.responseText,
        reason: input.reason,
        details: input.details || null,
        status: 'open',
        createdAt,
        ttl: Math.floor(Date.now() / 1000) + REPORT_TTL_SECONDS,
      },
    })
  );
  return reportId;
}
