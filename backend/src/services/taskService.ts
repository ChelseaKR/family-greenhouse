/**
 * DynamoDB-backed CRUD + query operations for plant care tasks.
 *
 * Tasks live in a household's partition (PK = `HOUSEHOLD#{id}`, SK =
 * `TASK#{taskId}`). Two GSIs make common queries fast:
 *
 *   GSI1 — sorted by next-due date for the upcoming-tasks dashboard
 *   GSI2 — sorted by assignee for the "tasks assigned to me" filter
 *
 * Completion records live under a separate plant partition
 * (`HOUSEHOLD#{id}#PLANT#{plantId}`) but additionally project onto GSI1
 * under `HOUSEHOLD#{id}#ACTIVITY` so the household activity feed is one query.
 *
 * See docs/architecture.md for the full key map.
 */
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { Task, TaskCompletion, DynamoDBItem } from '../models/types.js';
import { CreateTaskInput, UpdateTaskInput, TaskFilters } from '../models/schemas.js';
import { getMemberByUserId } from './householdService.js';

const MAX_QUERY_LIMIT = 200;
const MAX_DUE_WITHIN_DAYS = 365;

export async function createTask(
  input: CreateTaskInput,
  householdId: string,
  userId: string,
  plantName: string
): Promise<Task> {
  const id = uuid();
  const now = new Date();
  const nextDue = input.nextDue || now.toISOString();

  let assignedToName: string | null = null;
  if (input.assignedTo) {
    const member = await getMemberByUserId(householdId, input.assignedTo);
    assignedToName = member?.name ?? null;
  }

  const task: Task = {
    id,
    householdId,
    plantId: input.plantId,
    plantName,
    type: input.type,
    customType: input.type === 'custom' ? input.customType || null : null,
    frequency: input.frequency,
    lastCompleted: null,
    nextDue,
    assignedTo: input.assignedTo || null,
    assignedToName,
    notes: input.notes || null,
    createdBy: userId,
    createdAt: now.toISOString(),
  };

  const item: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `TASK#${id}`,
    GSI1PK: `HOUSEHOLD#${householdId}`,
    GSI1SK: nextDue,
    entityType: 'Task',
    ...task,
  };

  if (input.assignedTo) {
    item.GSI2PK = `HOUSEHOLD#${householdId}#ASSIGNEE#${input.assignedTo}`;
    item.GSI2SK = nextDue;
  }

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return task;
}

export async function getTask(householdId: string, taskId: string): Promise<Task | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `TASK#${taskId}`,
      },
    })
  );

  if (!result.Item) {
    return null;
  }

  return itemToTask(result.Item);
}

export async function getTasks(householdId: string, filters?: TaskFilters): Promise<Task[]> {
  let result;

  if (filters?.assignedTo) {
    // Use GSI2 for assignee queries
    result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}#ASSIGNEE#${filters.assignedTo}`,
        },
        Limit: MAX_QUERY_LIMIT,
      })
    );
  } else {
    result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}`,
          ':sk': 'TASK#',
        },
        Limit: MAX_QUERY_LIMIT,
      })
    );
  }

  let tasks = (result.Items || []).map(itemToTask);

  // Apply additional filters
  if (filters?.plantId) {
    tasks = tasks.filter((t) => t.plantId === filters.plantId);
  }

  if (filters?.overdue) {
    const now = new Date().toISOString();
    tasks = tasks.filter((t) => t.nextDue < now);
  }

  if (filters?.dueWithin !== undefined) {
    // Clamp untrusted query string values; otherwise a caller can pass
    // dueWithin=99999999 and we churn through every task in the household.
    const days = Math.max(0, Math.min(filters.dueWithin, MAX_DUE_WITHIN_DAYS));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    tasks = tasks.filter((t) => new Date(t.nextDue) <= cutoff);
  }

  return tasks;
}

export async function getUpcomingTasks(householdId: string): Promise<Task[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 7);

  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK <= :cutoff',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':cutoff': cutoff.toISOString(),
      },
    })
  );

  return (result.Items || [])
    .filter((item) => item.entityType === 'Task')
    .map(itemToTask)
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime());
}

export async function updateTask(
  householdId: string,
  taskId: string,
  input: UpdateTaskInput
): Promise<Task | null> {
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (input.type !== undefined) {
    updateExpressions.push('#type = :type');
    expressionAttributeNames['#type'] = 'type';
    expressionAttributeValues[':type'] = input.type;
  }

  if (input.customType !== undefined) {
    updateExpressions.push('#customType = :customType');
    expressionAttributeNames['#customType'] = 'customType';
    expressionAttributeValues[':customType'] = input.customType;
  }

  if (input.frequency !== undefined) {
    updateExpressions.push('#frequency = :frequency');
    expressionAttributeNames['#frequency'] = 'frequency';
    expressionAttributeValues[':frequency'] = input.frequency;
  }

  if (input.assignedTo !== undefined) {
    updateExpressions.push('#assignedTo = :assignedTo');
    expressionAttributeNames['#assignedTo'] = 'assignedTo';
    expressionAttributeValues[':assignedTo'] = input.assignedTo;
  }

  if (input.notes !== undefined) {
    updateExpressions.push('#notes = :notes');
    expressionAttributeNames['#notes'] = 'notes';
    expressionAttributeValues[':notes'] = input.notes;
  }

  if (input.nextDue !== undefined) {
    updateExpressions.push('#nextDue = :nextDue');
    expressionAttributeNames['#nextDue'] = 'nextDue';
    expressionAttributeValues[':nextDue'] = input.nextDue;

    updateExpressions.push('GSI1SK = :gsi1sk');
    expressionAttributeValues[':gsi1sk'] = input.nextDue;
  }

  if (updateExpressions.length === 0) {
    return getTask(householdId, taskId);
  }

  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `TASK#${taskId}`,
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
      ConditionExpression: 'attribute_exists(PK)',
    })
  );

  if (!result.Attributes) {
    return null;
  }

  return itemToTask(result.Attributes);
}

export async function deleteTask(householdId: string, taskId: string): Promise<boolean> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `TASK#${taskId}`,
        },
        // Atomic existence check — saves a GetItem roundtrip in the handler
        // and folds the not-found case into a single ConditionalCheckFailed
        // exception instead of a TOCTOU window.
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

export async function completeTask(
  householdId: string,
  taskId: string,
  userId: string,
  userName: string,
  notes?: string
): Promise<Task | null> {
  const task = await getTask(householdId, taskId);
  if (!task) {
    return null;
  }

  const now = new Date();
  const nextDue = new Date(now);
  nextDue.setDate(nextDue.getDate() + task.frequency);

  // Create completion record
  const completionId = uuid();
  const completion: TaskCompletion = {
    id: completionId,
    householdId,
    plantId: task.plantId,
    taskId,
    taskType: task.customType || task.type,
    completedBy: userId,
    completedByName: userName,
    completedAt: now.toISOString(),
    notes: notes || null,
  };

  const completionItem: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}#PLANT#${task.plantId}`,
    SK: `COMPLETION#${now.toISOString()}#${completionId}`,
    // GSI1 lets us fan across all plants in a household to feed the activity
    // page. We query GSI1PK = HOUSEHOLD#{id}#ACTIVITY ScanIndexForward=false
    // for newest-first.
    GSI1PK: `HOUSEHOLD#${householdId}#ACTIVITY`,
    GSI1SK: now.toISOString(),
    entityType: 'TaskCompletion',
    ...completion,
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: completionItem }));

  // Update task with new due date
  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `TASK#${taskId}`,
      },
      UpdateExpression:
        'SET #lastCompleted = :lastCompleted, #nextDue = :nextDue, GSI1SK = :nextDue',
      ExpressionAttributeNames: {
        '#lastCompleted': 'lastCompleted',
        '#nextDue': 'nextDue',
      },
      ExpressionAttributeValues: {
        ':lastCompleted': now.toISOString(),
        ':nextDue': nextDue.toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  if (!result.Attributes) {
    return null;
  }

  return itemToTask(result.Attributes);
}

export async function snoozeTask(
  householdId: string,
  taskId: string,
  days: number
): Promise<Task | null> {
  const task = await getTask(householdId, taskId);
  if (!task) return null;

  const next = new Date(task.nextDue);
  if (Number.isNaN(next.getTime())) {
    next.setTime(Date.now());
  }
  next.setDate(next.getDate() + days);

  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `TASK#${taskId}`,
      },
      UpdateExpression: 'SET #nextDue = :nextDue, GSI1SK = :nextDue',
      ExpressionAttributeNames: { '#nextDue': 'nextDue' },
      ExpressionAttributeValues: { ':nextDue': next.toISOString() },
      ReturnValues: 'ALL_NEW',
      ConditionExpression: 'attribute_exists(PK)',
    })
  );

  if (!result.Attributes) return null;
  return itemToTask(result.Attributes);
}

export async function getTaskCompletions(
  householdId: string,
  plantId: string,
  limit = 20
): Promise<TaskCompletion[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
        ':sk': 'COMPLETION#',
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );

  return (result.Items || []).map((item) => ({
    id: item.id as string,
    householdId: item.householdId as string,
    plantId: item.plantId as string,
    taskId: item.taskId as string,
    taskType: item.taskType as string,
    completedBy: item.completedBy as string,
    completedByName: item.completedByName as string,
    completedAt: item.completedAt as string,
    notes: item.notes as string | null,
  }));
}

export async function getHouseholdActivity(
  householdId: string,
  limit = 50
): Promise<TaskCompletion[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
      },
      ScanIndexForward: false,
      Limit: Math.min(limit, MAX_QUERY_LIMIT),
    })
  );
  return (result.Items || [])
    .filter((item) => item.entityType === 'TaskCompletion')
    .map((item) => ({
      id: item.id as string,
      householdId: item.householdId as string,
      plantId: item.plantId as string,
      taskId: item.taskId as string,
      taskType: item.taskType as string,
      completedBy: item.completedBy as string,
      completedByName: item.completedByName as string,
      completedAt: item.completedAt as string,
      notes: item.notes as string | null,
    }));
}

export interface YearInReview {
  year: number;
  totalCompletions: number;
  byMember: Array<{ userId: string; name: string; count: number }>;
  byTaskType: Array<{ type: string; count: number }>;
  topPlants: Array<{ plantId: string; count: number }>;
}

/**
 * Aggregate the household's completion records for a given calendar year.
 * Pure read over GSI1 — no per-plant query, no per-member query, just one
 * scan-then-bucket pass.
 */
export async function getYearInReview(householdId: string, year: number): Promise<YearInReview> {
  const start = `${year}-01-01T00:00:00.000Z`;
  const end = `${year + 1}-01-01T00:00:00.000Z`;
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
        ':start': start,
        ':end': end,
      },
      Limit: MAX_QUERY_LIMIT,
    })
  );

  const items = (result.Items || []).filter((i) => i.entityType === 'TaskCompletion');
  const memberCounts = new Map<string, { name: string; count: number }>();
  const typeCounts = new Map<string, number>();
  const plantCounts = new Map<string, number>();

  for (const it of items) {
    const userId = it.completedBy as string;
    const name = (it.completedByName as string) ?? userId;
    const type = it.taskType as string;
    const plantId = it.plantId as string;
    const m = memberCounts.get(userId);
    memberCounts.set(userId, { name, count: (m?.count ?? 0) + 1 });
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    plantCounts.set(plantId, (plantCounts.get(plantId) ?? 0) + 1);
  }

  return {
    year,
    totalCompletions: items.length,
    byMember: [...memberCounts.entries()]
      .map(([userId, v]) => ({ userId, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count),
    byTaskType: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    topPlants: [...plantCounts.entries()]
      .map(([plantId, count]) => ({ plantId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

/**
 * Daily completion counts for the trailing N days. Always returns one entry
 * per day (zero-filled) so the UI doesn't have to build the date scaffold.
 */
export async function getDailyCompletionCounts(
  householdId: string,
  days: number
): Promise<Array<{ date: string; count: number }>> {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);

  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
        ':start': start.toISOString(),
        ':end': now.toISOString(),
      },
      Limit: MAX_QUERY_LIMIT,
    })
  );

  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const it of result.Items ?? []) {
    if (it.entityType !== 'TaskCompletion') continue;
    const key = (it.completedAt as string).slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

export async function getTasksForPlant(householdId: string, plantId: string): Promise<Task[]> {
  const tasks = await getTasks(householdId);
  return tasks
    .filter((t) => t.plantId === plantId)
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime());
}

function itemToTask(item: Record<string, unknown>): Task {
  return {
    id: item.id as string,
    householdId: item.householdId as string,
    plantId: item.plantId as string,
    plantName: item.plantName as string,
    type: item.type as Task['type'],
    customType: item.customType as string | null,
    frequency: item.frequency as number,
    lastCompleted: item.lastCompleted as string | null,
    nextDue: item.nextDue as string,
    assignedTo: item.assignedTo as string | null,
    assignedToName: item.assignedToName as string | null,
    notes: item.notes as string | null,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as string,
  };
}
