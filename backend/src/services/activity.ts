/**
 * Household activity event log. Generalizes the existing TaskCompletion
 * partition (`HOUSEHOLD#{id}#ACTIVITY` on GSI1) to carry other event types
 * — plants added, members joined, photos uploaded — so the activity feed
 * reads as the household's full story, not just task completions.
 *
 * Event records share a common envelope with a discriminator (`type`) and
 * an event-specific `payload`. We deliberately don't normalize across
 * events (no shared "actor"/"target" columns); each renderer in the UI
 * pattern-matches on `type`.
 */
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

export type ActivityType =
  | 'task.completed'
  | 'plant.created'
  | 'plant.deleted'
  | 'photo.uploaded'
  | 'member.joined'
  | 'member.left';

export interface ActivityEvent<T = unknown> {
  id: string;
  type: ActivityType;
  householdId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
  payload: T;
}

const MAX_LIMIT = 200;

/**
 * Record an event to the household activity log. Best-effort — the caller
 * should not block its main work on a failure here. (We log and continue
 * rather than reject; the user-visible side effect is "the activity feed
 * is missing one row," which is far better than a write that succeeded
 * partially.)
 */
export async function recordActivity<T>(input: {
  type: ActivityType;
  householdId: string;
  actorId: string;
  actorName: string;
  payload: T;
}): Promise<void> {
  const id = uuid();
  const now = new Date().toISOString();
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${input.householdId}#ACTIVITY`,
        SK: `EVENT#${now}#${id}`,
        GSI1PK: `HOUSEHOLD#${input.householdId}#ACTIVITY`,
        GSI1SK: now,
        entityType: 'ActivityEvent',
        id,
        type: input.type,
        householdId: input.householdId,
        actorId: input.actorId,
        actorName: input.actorName,
        occurredAt: now,
        payload: input.payload,
      },
    })
  );
}

/**
 * Newest-first activity for a household. Includes both legacy TaskCompletion
 * rows (already on this GSI partition) and ActivityEvent rows; the response
 * shape is the unified envelope so the frontend renders them uniformly.
 */
export async function listActivity(householdId: string, limit = 50): Promise<ActivityEvent[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
      },
      ScanIndexForward: false,
      Limit: Math.min(limit, MAX_LIMIT),
    })
  );

  return (result.Items ?? []).map((item) => {
    if (item.entityType === 'ActivityEvent') {
      return {
        id: item.id as string,
        type: item.type as ActivityType,
        householdId: item.householdId as string,
        actorId: item.actorId as string,
        actorName: item.actorName as string,
        occurredAt: item.occurredAt as string,
        payload: item.payload as unknown,
      };
    }
    // TaskCompletion legacy shape — fold into the envelope.
    return {
      id: item.id as string,
      type: 'task.completed' as ActivityType,
      householdId: item.householdId as string,
      actorId: item.completedBy as string,
      actorName: (item.completedByName as string) ?? '',
      occurredAt: (item.completedAt as string) ?? '',
      payload: {
        plantId: item.plantId as string,
        taskId: item.taskId as string,
        taskType: item.taskType as string,
        notes: (item.notes as string | null) ?? null,
      },
    };
  });
}
