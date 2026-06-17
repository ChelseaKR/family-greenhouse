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
import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { Task, TaskCompletion, DynamoDBItem } from '../models/types.js';
import { CreateTaskInput, UpdateTaskInput, TaskFilters } from '../models/schemas.js';
import { getMemberByUserId } from './householdService.js';
import * as plantService from './plantService.js';
import { recordActivity } from './activity.js';

const MAX_QUERY_LIMIT = 200;
const MAX_DUE_WITHIN_DAYS = 365;
// Vacation rows outlive their endDate by a buffer so a clock-skewed TTL
// sweep can never delete a still-active window; reads filter by endDate.
const VACATION_TTL_BUFFER_MS = 3 * 24 * 60 * 60 * 1000;
// Hard ceiling on pagination: 10 pages × 200 items = 2,000 rows per query.
// Paid plans allow thousands of plants/tasks, so a single 200-item page
// silently truncated results; the ceiling keeps a runaway partition from
// pinning Lambda memory while still covering every legitimate workload.
const MAX_QUERY_PAGES = 10;

/**
 * Raised when a task create/update/import would assign the task to a userId
 * that is not a current member of the household. Without this guard the task
 * wrote with a dangling assignee — invisible in every member's "assigned to
 * me" view and rolled into the unassigned bucket by reminders. Handlers map
 * this to a 400 (call sites check `err.name === 'AssigneeNotMemberError'`, not
 * instanceof, so test automocks stay compatible — same convention as
 * PlanLimitError).
 */
export class AssigneeNotMemberError extends Error {
  constructor(message = 'assignedTo must be a current household member') {
    super(message);
    this.name = 'AssigneeNotMemberError';
  }
}

/**
 * Run a Query and follow LastEvaluatedKey up to MAX_QUERY_PAGES pages.
 * DynamoDB applies `Limit` per page *before* filtering, so any single-page
 * query with Limit set risks silent truncation — use this for anything that
 * must see the whole result set.
 */
async function queryAllPages(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (exclusiveStartKey && pages < MAX_QUERY_PAGES);
  return items;
}

/**
 * The set of active plant ids for a household, used to hide tasks whose
 * plant has died / been given away. The task rows are intentionally kept
 * (history, year-in-review) — they're just filtered out of live task views.
 */
async function getActivePlantIdSet(householdId: string): Promise<Set<string>> {
  const plants = await plantService.getPlants(householdId);
  return new Set(plants.map((p) => p.id));
}

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
    // Reject a dangling assignee rather than writing a task nobody can see (M4).
    if (!member) throw new AssigneeNotMemberError();
    assignedToName = member.name;
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

export async function getTasks(
  householdId: string,
  filters?: TaskFilters
): Promise<TaskWithCoverage[]> {
  let items: Record<string, unknown>[];

  if (filters?.assignedTo) {
    // Use GSI2 for assignee queries
    items = await queryAllPages({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ASSIGNEE#${filters.assignedTo}`,
      },
      Limit: MAX_QUERY_LIMIT,
    });
  } else {
    items = await queryAllPages({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'TASK#',
      },
      Limit: MAX_QUERY_LIMIT,
    });
  }

  let tasks = items.map(itemToTask);

  // Lifecycle filter: tasks whose plant died / was given away must not
  // surface in task lists. This also covers the ICS calendar feed, which
  // builds from getTasks.
  const activePlantIds = await getActivePlantIdSet(householdId);
  tasks = tasks.filter((t) => activePlantIds.has(t.plantId));

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

  // Vacation read-time mapping: annotate (never rewrite) tasks whose
  // assignee is currently away.
  return annotateTasksWithCoverage(tasks, await getActiveVacationMap(householdId));
}

/**
 * The minimal, PII-free task shape a plant-sitter sees. Deliberately NOT the
 * full Task: no assignee names/ids, no createdBy, no notes (notes can contain
 * household-private context), no householdId. Just enough to do the job:
 * which plant, what to do, when it's due.
 */
export interface SitterTask {
  taskId: string;
  plantName: string;
  taskType: string;
  dueDate: string;
  /** True when dueDate is in the past — drives the "overdue" badge. */
  overdue: boolean;
}

/**
 * Due/overdue tasks for the plant-sitter view, projected to the PII-free
 * SitterTask shape. "Due" means due within the next `dueWithinDays` days OR
 * already overdue — the sitter should see everything that needs doing during
 * their window, not just strictly-overdue items. Tasks for died/gave_away
 * plants are filtered out (getTasks already does this). The returned objects
 * expose ONLY plant common name, task type, due date, and id — see SitterTask.
 */
export async function getSitterTasks(
  householdId: string,
  now: Date = new Date(),
  dueWithinDays = 7
): Promise<SitterTask[]> {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + dueWithinDays);
  const cutoffIso = cutoff.toISOString();
  const nowIso = now.toISOString();

  // getTasks already lifecycle-filters (active plants only) and returns the
  // denormalized plantName + customType we need — reuse it rather than
  // re-deriving the projection.
  const tasks = await getTasks(householdId);
  return tasks
    .filter((t) => t.nextDue <= cutoffIso)
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime())
    .map((t) => ({
      taskId: t.id,
      plantName: t.plantName,
      taskType: t.customType || t.type,
      dueDate: t.nextDue,
      overdue: t.nextDue < nowIso,
    }));
}

export async function getUpcomingTasks(householdId: string): Promise<TaskWithCoverage[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 7);

  const tasks = await getTasksDueBy(householdId, cutoff.toISOString());

  // Lifecycle filter: hide tasks for died / gave_away plants.
  const activePlantIds = await getActivePlantIdSet(householdId);
  const upcoming = tasks
    .filter((t) => activePlantIds.has(t.plantId))
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime());

  // Vacation read-time mapping (see annotateTasksWithCoverage).
  return annotateTasksWithCoverage(upcoming, await getActiveVacationMap(householdId));
}

/**
 * Every Task row due on/before `cutoffIso` — one paginated GSI1 query.
 * Used by the reminder fan-out (one query per household instead of one
 * GSI2 query per member) and by getUpcomingTasks.
 *
 * NOTE: no lifecycle filtering here — callers that present these to users
 * filter against the active-plant set themselves (reminders already does).
 */
export async function getTasksDueBy(householdId: string, cutoffIso: string): Promise<Task[]> {
  const items = await queryAllPages({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK <= :cutoff',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}`,
      ':cutoff': cutoffIso,
    },
    Limit: MAX_QUERY_LIMIT,
  });

  return items.filter((item) => item.entityType === 'Task').map(itemToTask);
}

export async function updateTask(
  householdId: string,
  taskId: string,
  input: UpdateTaskInput
): Promise<Task | null> {
  const setExpressions: string[] = [];
  const removeExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (input.type !== undefined) {
    setExpressions.push('#type = :type');
    expressionAttributeNames['#type'] = 'type';
    expressionAttributeValues[':type'] = input.type;
  }

  if (input.customType !== undefined) {
    setExpressions.push('#customType = :customType');
    expressionAttributeNames['#customType'] = 'customType';
    expressionAttributeValues[':customType'] = input.customType;
  }

  if (input.frequency !== undefined) {
    setExpressions.push('#frequency = :frequency');
    expressionAttributeNames['#frequency'] = 'frequency';
    expressionAttributeValues[':frequency'] = input.frequency;
  }

  if (input.assignedTo !== undefined) {
    setExpressions.push('#assignedTo = :assignedTo', '#assignedToName = :assignedToName');
    expressionAttributeNames['#assignedTo'] = 'assignedTo';
    expressionAttributeNames['#assignedToName'] = 'assignedToName';
    expressionAttributeValues[':assignedTo'] = input.assignedTo || null;

    if (input.assignedTo) {
      // Re-resolve the denormalized assignee name — without this the task
      // keeps displaying the previous assignee after reassignment. Reject a
      // reassignment to a non-member rather than persist a dangling one (M4).
      const member = await getMemberByUserId(householdId, input.assignedTo);
      if (!member) throw new AssigneeNotMemberError();
      expressionAttributeValues[':assignedToName'] = member.name;

      // GSI2 keys must follow the assignment (createTask sets them; updateTask
      // historically didn't, so "tasks assigned to me" kept returning stale
      // results). GSI2SK mirrors nextDue: use the incoming value if this same
      // update changes it, otherwise the stored one.
      const effectiveNextDue =
        input.nextDue ?? (await getTask(householdId, taskId))?.nextDue ?? new Date().toISOString();
      setExpressions.push('GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
      expressionAttributeValues[':gsi2pk'] =
        `HOUSEHOLD#${householdId}#ASSIGNEE#${input.assignedTo}`;
      expressionAttributeValues[':gsi2sk'] = effectiveNextDue;
    } else {
      // Unassigning: drop the item from GSI2 entirely so it stops appearing
      // under the old assignee.
      expressionAttributeValues[':assignedToName'] = null;
      removeExpressions.push('GSI2PK', 'GSI2SK');
    }
  }

  if (input.notes !== undefined) {
    setExpressions.push('#notes = :notes');
    expressionAttributeNames['#notes'] = 'notes';
    expressionAttributeValues[':notes'] = input.notes;
  }

  if (input.nextDue !== undefined) {
    setExpressions.push('#nextDue = :nextDue');
    expressionAttributeNames['#nextDue'] = 'nextDue';
    expressionAttributeValues[':nextDue'] = input.nextDue;

    setExpressions.push('GSI1SK = :gsi1sk');
    expressionAttributeValues[':gsi1sk'] = input.nextDue;

    if (input.assignedTo === undefined) {
      // Keep the assignee index's sort key in sync with nextDue. On an
      // unassigned task this writes a dangling GSI2SK attribute, which is
      // harmless — the item only appears in GSI2 when GSI2PK is present.
      setExpressions.push('GSI2SK = :gsi2sk');
      expressionAttributeValues[':gsi2sk'] = input.nextDue;
    }
  }

  if (setExpressions.length === 0 && removeExpressions.length === 0) {
    return getTask(householdId, taskId);
  }

  let updateExpression = `SET ${setExpressions.join(', ')}`;
  if (removeExpressions.length > 0) {
    updateExpression += ` REMOVE ${removeExpressions.join(', ')}`;
  }

  let result;
  try {
    result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `TASK#${taskId}`,
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Task doesn't exist (deleted between read and write) — 404, not 500.
      return null;
    }
    throw err;
  }

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

  // Advance the task FIRST, guarded two ways:
  //  - attribute_exists(PK): completing a concurrently-deleted task must not
  //    resurrect it as a ghost row (UpdateItem upserts by default).
  //  - #nextDue = :expectedNextDue: a double-tap (or two members completing
  //    at once) only advances the schedule once. The loser of the race gets
  //    ConditionalCheckFailed and we treat it as an already-completed no-op
  //    returning current state — crucially *before* the completion record is
  //    written, so no duplicate row lands in the activity feed.
  // GSI2SK mirrors nextDue for assigned tasks; setting it on an unassigned
  // task leaves a dangling attribute, which is harmless (no GSI2PK → not in
  // the index).
  let result;
  try {
    result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `TASK#${taskId}`,
        },
        UpdateExpression:
          'SET #lastCompleted = :lastCompleted, #nextDue = :nextDue, GSI1SK = :nextDue, GSI2SK = :nextDue',
        ExpressionAttributeNames: {
          '#lastCompleted': 'lastCompleted',
          '#nextDue': 'nextDue',
        },
        ExpressionAttributeValues: {
          ':lastCompleted': now.toISOString(),
          ':nextDue': nextDue.toISOString(),
          ':expectedNextDue': task.nextDue,
        },
        ConditionExpression: 'attribute_exists(PK) AND #nextDue = :expectedNextDue',
        ReturnValues: 'ALL_NEW',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Already completed by a concurrent request (nextDue moved) or deleted
      // under us. Return the current row (null if deleted) as a no-op.
      return getTask(householdId, taskId);
    }
    throw err;
  }

  // Record the completion only after the task actually advanced. If this Put
  // fails the schedule is still correct and only one history row is missing —
  // the safer failure mode than duplicate completions.
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

  // Base the snooze on max(now, current nextDue): snoozing a task that's
  // already overdue should push it N days into the *future* — basing on the
  // stale nextDue could leave it still overdue after "snoozing".
  const current = new Date(task.nextDue);
  const baseMs = Number.isNaN(current.getTime())
    ? Date.now()
    : Math.max(Date.now(), current.getTime());
  const next = new Date(baseMs);
  next.setDate(next.getDate() + days);

  let result;
  try {
    result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `TASK#${taskId}`,
        },
        // GSI2SK mirrors nextDue (dangling-but-harmless on unassigned tasks).
        UpdateExpression: 'SET #nextDue = :nextDue, GSI1SK = :nextDue, GSI2SK = :nextDue',
        ExpressionAttributeNames: { '#nextDue': 'nextDue' },
        ExpressionAttributeValues: { ':nextDue': next.toISOString() },
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Deleted between read and write — 404, not 500.
      return null;
    }
    throw err;
  }

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
  const want = Math.min(limit, MAX_QUERY_LIMIT);

  // GSI1 HOUSEHOLD#{id}#ACTIVITY now holds both TaskCompletion AND ActivityEvent
  // rows. DynamoDB applies `Limit` per page BEFORE our entityType filter, so a
  // single Limit-bounded page that happens to be mostly ActivityEvents returns
  // far fewer than `want` completions (M3). Page through newest-first,
  // accumulating only completions, until we have enough or run out of pages
  // (bounded by MAX_QUERY_PAGES — same ceiling as queryAllPages).
  const completions: TaskCompletion[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
        },
        ScanIndexForward: false,
        Limit: MAX_QUERY_LIMIT,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of result.Items ?? []) {
      if (item.entityType !== 'TaskCompletion') continue;
      completions.push({
        id: item.id as string,
        householdId: item.householdId as string,
        plantId: item.plantId as string,
        taskId: item.taskId as string,
        taskType: item.taskType as string,
        completedBy: item.completedBy as string,
        completedByName: item.completedByName as string,
        completedAt: item.completedAt as string,
        notes: item.notes as string | null,
      });
      if (completions.length >= want) return completions;
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (exclusiveStartKey && pages < MAX_QUERY_PAGES);

  return completions;
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
  // Paginated: an active household easily logs >200 completions/year, and a
  // single-page query silently undercounted everything past the first page.
  const allItems = await queryAllPages({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
      ':start': start,
      ':end': end,
    },
    Limit: MAX_QUERY_LIMIT,
  });

  const items = allItems.filter((i) => i.entityType === 'TaskCompletion');
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

  // Paginated for the same reason as getYearInReview — a busy household can
  // exceed one page within the window.
  const items = await queryAllPages({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
      ':start': start.toISOString(),
      ':end': now.toISOString(),
    },
    Limit: MAX_QUERY_LIMIT,
  });

  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const it of items) {
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

// ---------------------------------------------------------------------------
// Task claiming ("up for grabs")
// ---------------------------------------------------------------------------

/**
 * Atomically claim an unassigned task for `userId`.
 *
 * The ConditionExpression guards both halves of the race in one write:
 * the task must still exist AND must not already have an assignee. Two
 * members tapping "Claim" at once means exactly one wins; the loser's
 * conditional write fails and we re-read to distinguish "someone beat you
 * to it" ('already_claimed' → 409 in the handler) from "task was deleted
 * under you" (null → 404).
 *
 * GSI2SK is set from the stored nextDue (`SET GSI2SK = #nextDue` references
 * the live attribute) so the assignee index never goes stale, with no
 * read-modify-write window.
 */
export async function claimTask(
  householdId: string,
  taskId: string,
  userId: string
): Promise<Task | 'already_claimed' | null> {
  // Caller's member-row name — the same denormalization createTask uses.
  const member = await getMemberByUserId(householdId, userId);

  let result;
  try {
    result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `TASK#${taskId}`,
        },
        UpdateExpression:
          'SET #assignedTo = :userId, #assignedToName = :name, GSI2PK = :gsi2pk, GSI2SK = #nextDue',
        ExpressionAttributeNames: {
          '#assignedTo': 'assignedTo',
          '#assignedToName': 'assignedToName',
          '#nextDue': 'nextDue',
        },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':name': member?.name ?? null,
          ':gsi2pk': `HOUSEHOLD#${householdId}#ASSIGNEE#${userId}`,
          ':null': null,
        },
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(#assignedTo) OR #assignedTo = :null)',
        ReturnValues: 'ALL_NEW',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const current = await getTask(householdId, taskId);
      if (!current) return null; // deleted under us → 404
      return 'already_claimed'; // someone else won the race → 409
    }
    throw err;
  }

  if (!result.Attributes) return null;
  const task = itemToTask(result.Attributes);

  // Best-effort feed entry (recordActivity logs-and-continues on failure).
  await recordActivity({
    type: 'task.claimed',
    householdId,
    actorId: userId,
    actorName: member?.name ?? '',
    payload: {
      taskId,
      plantId: task.plantId,
      plantName: task.plantName,
      taskType: task.customType || task.type,
    },
  });

  return task;
}

/**
 * Release a claimed task. Only the current assignee may unclaim — enforced
 * atomically by the ConditionExpression (`assignedTo = :userId`), so a
 * stale UI can't strip someone else's assignment. Conditional failure is
 * disambiguated the same way as claimTask: null → 404, 'not_assignee' → 403.
 */
export async function unclaimTask(
  householdId: string,
  taskId: string,
  userId: string
): Promise<Task | 'not_assignee' | null> {
  let result;
  try {
    result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `TASK#${taskId}`,
        },
        UpdateExpression: 'SET #assignedTo = :null, #assignedToName = :null REMOVE GSI2PK, GSI2SK',
        ExpressionAttributeNames: {
          '#assignedTo': 'assignedTo',
          '#assignedToName': 'assignedToName',
        },
        ExpressionAttributeValues: {
          ':null': null,
          ':userId': userId,
        },
        ConditionExpression: 'attribute_exists(PK) AND #assignedTo = :userId',
        ReturnValues: 'ALL_NEW',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const current = await getTask(householdId, taskId);
      if (!current) return null; // 404
      return 'not_assignee'; // 403 — only the current assignee can unclaim
    }
    throw err;
  }

  if (!result.Attributes) return null;
  const task = itemToTask(result.Attributes);

  const member = await getMemberByUserId(householdId, userId);
  await recordActivity({
    type: 'task.unclaimed',
    householdId,
    actorId: userId,
    actorName: member?.name ?? '',
    payload: {
      taskId,
      plantId: task.plantId,
      plantName: task.plantName,
      taskType: task.customType || task.type,
    },
  });

  return task;
}

// ---------------------------------------------------------------------------
// Vacation windows (care handoff)
// ---------------------------------------------------------------------------
//
// Row shape: PK = HOUSEHOLD#{id}, SK = VACATION#{userId} — at most ONE window
// per member per household, so "set vacation" is an idempotent upsert and
// cancel is a single delete. The mapping is read-time only: tasks keep their
// assignedTo and the window auto-reverts simply by expiring (no data rewrite,
// no un-handoff job). A DynamoDB TTL a few days past endDate garbage-collects
// the row; reads always filter by endDate so the buffer is invisible.

export interface VacationWindow {
  householdId: string;
  /** The member who is away. */
  userId: string;
  /** The member covering their tasks while the window is active. */
  coveredBy: string;
  /** Denormalized cover name (same pattern as Task.assignedToName). */
  coveredByName: string | null;
  startDate: string;
  endDate: string;
  createdBy: string;
  createdAt: string;
}

/** Task + read-time vacation annotation. assignedTo is NEVER rewritten —
 *  the annotation disappears by itself when the window expires. */
export interface TaskWithCoverage extends Task {
  /** Who should actually do the task right now (the cover). */
  effectiveAssignee?: string;
  effectiveAssigneeName?: string | null;
  /** Name of the away assignee — drives the "Covering for X" badge. */
  coveringFor?: string | null;
}

function itemToVacation(item: Record<string, unknown>): VacationWindow {
  return {
    householdId: item.householdId as string,
    userId: item.userId as string,
    coveredBy: item.coveredBy as string,
    coveredByName: (item.coveredByName as string | null) ?? null,
    startDate: item.startDate as string,
    endDate: item.endDate as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as string,
  };
}

/**
 * Upsert the (single) vacation window for `input.userId`. Validation —
 * member checks, coveredBy !== userId, date sanity — lives in the handler
 * + Zod schema; this just writes the row with its TTL.
 */
export async function setVacationWindow(
  householdId: string,
  input: {
    userId: string;
    coveredBy: string;
    coveredByName: string | null;
    startDate: string;
    endDate: string;
  },
  createdBy: string
): Promise<VacationWindow> {
  const window: VacationWindow = {
    householdId,
    userId: input.userId,
    coveredBy: input.coveredBy,
    coveredByName: input.coveredByName,
    startDate: input.startDate,
    endDate: input.endDate,
    createdBy,
    createdAt: new Date().toISOString(),
  };

  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `VACATION#${input.userId}`,
        entityType: 'VacationWindow',
        ttl: Math.floor((Date.parse(input.endDate) + VACATION_TTL_BUFFER_MS) / 1000),
        ...window,
      },
    })
  );

  return window;
}

/** Cancel a member's vacation window. False when there was none (→ 404). */
export async function deleteVacationWindow(householdId: string, userId: string): Promise<boolean> {
  try {
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `HOUSEHOLD#${householdId}`,
          SK: `VACATION#${userId}`,
        },
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

/**
 * All windows that haven't ended yet (active now OR starting in the future —
 * the UI needs upcoming windows so a vacation set for next week can still be
 * seen and cancelled). Rows past endDate are filtered out here even before
 * the TTL sweep removes them — that's the auto-revert.
 */
export async function listVacationWindows(
  householdId: string,
  now: Date = new Date()
): Promise<VacationWindow[]> {
  const items = await queryAllPages({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `HOUSEHOLD#${householdId}`,
      ':sk': 'VACATION#',
    },
    Limit: MAX_QUERY_LIMIT,
  });
  const nowIso = now.toISOString();
  return items.map(itemToVacation).filter((w) => w.endDate >= nowIso);
}

/** Map of away-member userId → their CURRENTLY active window (start ≤ now ≤ end). */
export async function getActiveVacationMap(
  householdId: string,
  now: Date = new Date()
): Promise<Map<string, VacationWindow>> {
  const nowIso = now.toISOString();
  const map = new Map<string, VacationWindow>();
  for (const w of await listVacationWindows(householdId, now)) {
    if (w.startDate <= nowIso && nowIso <= w.endDate) {
      map.set(w.userId, w);
    }
  }
  return map;
}

/**
 * Pure read-time mapping: tasks assigned to an away member gain the
 * effectiveAssignee/coveringFor annotation. Exported for direct unit
 * testing; getTasks/getUpcomingTasks apply it to their responses.
 */
export function annotateTasksWithCoverage(
  tasks: Task[],
  vacations: Map<string, VacationWindow>
): TaskWithCoverage[] {
  if (vacations.size === 0) return tasks;
  return tasks.map((t) => {
    const w = t.assignedTo ? vacations.get(t.assignedTo) : undefined;
    if (!w || w.coveredBy === t.assignedTo) return t;
    return {
      ...t,
      effectiveAssignee: w.coveredBy,
      effectiveAssigneeName: w.coveredByName,
      coveringFor: t.assignedToName,
    };
  });
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
