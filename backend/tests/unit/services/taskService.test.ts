import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  BatchWriteCommand: vi.fn(function (input) {
    return { input, kind: 'BatchWrite' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: vi.fn() };
  }),
  ListObjectsV2Command: vi.fn(function (input) {
    return { input, kind: 'ListObjectsV2' };
  }),
  DeleteObjectsCommand: vi.fn(function (input) {
    return { input, kind: 'DeleteObjects' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(),
}));

// Activity records are best-effort side writes; mock them out so dynamo
// call-count assertions stay about the task writes themselves.
vi.mock('../../../src/services/activity.js', () => ({
  recordActivity: vi.fn(),
}));

const baseTask = {
  id: 't1',
  householdId: 'hh-1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water',
  customType: null,
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-05-01T00:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'user-1',
  createdAt: '2026-04-25T00:00:00.000Z',
};

// Plant rows as returned from DDB; getPlants treats missing status as active.
const activePlantRows = [
  { id: 'p1', name: 'Pothos', householdId: 'hh-1' },
  { id: 'p2', name: 'Fern', householdId: 'hh-1' },
];

type SentCommand = { kind: string; input: Record<string, any> };

describe('taskService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('createTask writes a Put with GSI keys', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const task = await createTask(
      { plantId: 'p1', type: 'water', frequency: 7 },
      'hh-1',
      'user-1',
      'Pothos'
    );
    expect(task).toMatchObject({
      householdId: 'hh-1',
      plantId: 'p1',
      type: 'water',
      frequency: 7,
      assignedTo: null,
    });
    const sentCommand = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(sentCommand.input.Item.PK).toBe('HOUSEHOLD#hh-1');
    expect(sentCommand.input.Item.GSI1PK).toBe('HOUSEHOLD#hh-1');
    expect(sentCommand.input.Item.GSI2PK).toBeUndefined();
  });

  it('createTask sets GSI2 keys and assignee name when assignedTo provided', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { createTask } = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member',
      joinedAt: '',
    });
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const task = await createTask(
      { plantId: 'p1', type: 'water', frequency: 7, assignedTo: 'user-2' },
      'hh-1',
      'user-1',
      'Pothos'
    );
    expect(task.assignedToName).toBe('Bob');
    const sentCommand = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(sentCommand.input.Item.GSI2PK).toBe('HOUSEHOLD#hh-1#ASSIGNEE#user-2');
  });

  it('createTask rejects a non-member assignee with AssigneeNotMemberError and writes nothing (M4)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { createTask } = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    await expect(
      createTask(
        { plantId: 'p1', type: 'water', frequency: 7, assignedTo: 'ghost' },
        'hh-1',
        'user-1',
        'Pothos'
      )
    ).rejects.toMatchObject({ name: 'AssigneeNotMemberError' });
    // No Put attempted — the dangling assignee is refused before any write.
    expect(vi.mocked(dynamodb.send)).not.toHaveBeenCalled();
  });

  it('updateTask rejects a reassignment to a non-member with AssigneeNotMemberError (M4)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    await expect(updateTask('hh-1', 't1', { assignedTo: 'ghost' })).rejects.toMatchObject({
      name: 'AssigneeNotMemberError',
    });
    expect(vi.mocked(dynamodb.send)).not.toHaveBeenCalled();
  });

  it('getTask returns null when missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const result = await getTask('hh-1', 't1');
    expect(result).toBeNull();
  });

  it('getTasks applies plantId filter in memory', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          { ...baseTask, id: 't1', plantId: 'p1' },
          { ...baseTask, id: 't2', plantId: 'p2' },
        ],
      })
      // Second query: the lifecycle filter's getPlants call.
      .mockResolvedValueOnce({ Items: activePlantRows })
      // Third query: the vacation-window lookup for the coverage annotation.
      .mockResolvedValueOnce({ Items: [] });
    const tasks = await getTasks('hh-1', { plantId: 'p1' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('getTasks applies overdue filter in memory', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          { ...baseTask, id: 't1', nextDue: '2000-01-01T00:00:00.000Z' },
          { ...baseTask, id: 't2', nextDue: '2099-01-01T00:00:00.000Z' },
        ],
      })
      .mockResolvedValueOnce({ Items: activePlantRows })
      .mockResolvedValueOnce({ Items: [] }); // vacation lookup
    const tasks = await getTasks('hh-1', { overdue: true });
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('getTasks hides tasks whose plant is not active (died / gave_away)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          { ...baseTask, id: 't1', plantId: 'p1' },
          { ...baseTask, id: 't2', plantId: 'p-dead' },
          { ...baseTask, id: 't3', plantId: 'p-gone' },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          { id: 'p1', name: 'Pothos', householdId: 'hh-1', status: 'active' },
          { id: 'p-dead', name: 'Ex-fern', householdId: 'hh-1', status: 'died' },
          { id: 'p-gone', name: 'Gifted', householdId: 'hh-1', status: 'gave_away' },
        ],
      })
      .mockResolvedValueOnce({ Items: [] }); // vacation lookup
    const tasks = await getTasks('hh-1');
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('getTasks follows LastEvaluatedKey across pages', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [{ ...baseTask, id: 't1' }],
        LastEvaluatedKey: { PK: 'HOUSEHOLD#hh-1', SK: 'TASK#t1' },
      })
      .mockResolvedValueOnce({
        Items: [{ ...baseTask, id: 't2' }],
      })
      .mockResolvedValueOnce({ Items: activePlantRows })
      .mockResolvedValueOnce({ Items: [] }); // vacation lookup
    const tasks = await getTasks('hh-1');
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    // Two task pages + one plants query + one vacation query.
    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(4);
    const secondPage = calls[1][0] as unknown as SentCommand;
    expect(secondPage.input.ExclusiveStartKey).toEqual({
      PK: 'HOUSEHOLD#hh-1',
      SK: 'TASK#t1',
    });
  });

  it('getUpcomingTasks queries GSI1, filters non-task items and inactive plants', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getUpcomingTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          { ...baseTask, id: 't1', entityType: 'Task', nextDue: '2026-05-02T00:00:00.000Z' },
          { ...baseTask, id: 't2', entityType: 'Task', nextDue: '2026-05-01T00:00:00.000Z' },
          {
            ...baseTask,
            id: 't3',
            entityType: 'Task',
            plantId: 'p-dead',
            nextDue: '2026-05-01T00:00:00.000Z',
          },
          { entityType: 'Other' },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          ...activePlantRows,
          { id: 'p-dead', name: 'Dead', householdId: 'hh-1', status: 'died' },
        ],
      })
      .mockResolvedValueOnce({ Items: [] }); // vacation lookup
    const tasks = await getUpcomingTasks('hh-1');
    expect(tasks.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('getTasksDueBy queries GSI1 with the cutoff and paginates', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTasksDueBy } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [{ ...baseTask, id: 't1', entityType: 'Task' }],
        LastEvaluatedKey: { k: 1 },
      })
      .mockResolvedValueOnce({
        Items: [{ ...baseTask, id: 't2', entityType: 'Task' }, { entityType: 'Other' }],
      });
    const tasks = await getTasksDueBy('hh-1', '2026-05-02T00:00:00.000Z');
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const first = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as SentCommand;
    expect(first.input.IndexName).toBe('GSI1');
    expect(first.input.ExpressionAttributeValues[':cutoff']).toBe('2026-05-02T00:00:00.000Z');
  });

  it('updateTask short-circuits to a get when no fields provided', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: baseTask });
    const result = await updateTask('hh-1', 't1', {});
    expect(result?.id).toBe('t1');
    // Only one Get command — no Update.
    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as unknown as { kind: string }).kind).toBe('Get');
  });

  it('updateTask returns null when ConditionExpression rejects', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    const err = new Error('conditional');
    err.name = 'ConditionalCheckFailedException';
    vi.mocked(dynamodb.send).mockRejectedValueOnce(err);
    const result = await updateTask('hh-1', 't1', { frequency: 14 });
    expect(result).toBeNull();
  });

  it('updateTask reassignment sets GSI2 keys and re-resolves assignee name', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member',
      joinedAt: '',
    });
    vi.mocked(dynamodb.send)
      // getTask read to resolve the stored nextDue for GSI2SK.
      .mockResolvedValueOnce({ Item: baseTask })
      .mockResolvedValueOnce({
        Attributes: { ...baseTask, assignedTo: 'user-2', assignedToName: 'Bob' },
      });

    const result = await updateTask('hh-1', 't1', { assignedTo: 'user-2' });
    expect(result?.assignedToName).toBe('Bob');
    expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-1', 'user-2');

    const update = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as SentCommand)
      .find((c) => c.kind === 'Update')!;
    expect(update.input.UpdateExpression).toContain('GSI2PK = :gsi2pk');
    expect(update.input.UpdateExpression).toContain('GSI2SK = :gsi2sk');
    expect(update.input.ExpressionAttributeValues[':gsi2pk']).toBe(
      'HOUSEHOLD#hh-1#ASSIGNEE#user-2'
    );
    // GSI2SK mirrors the stored nextDue when the update doesn't change it.
    expect(update.input.ExpressionAttributeValues[':gsi2sk']).toBe(baseTask.nextDue);
    expect(update.input.ExpressionAttributeValues[':assignedToName']).toBe('Bob');
  });

  it('updateTask unassign (assignedTo: null) REMOVEs GSI2 keys and clears the name', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: { ...baseTask, assignedTo: null, assignedToName: null },
    });

    const result = await updateTask('hh-1', 't1', { assignedTo: null });
    expect(result?.assignedTo).toBeNull();
    expect(householdService.getMemberByUserId).not.toHaveBeenCalled();

    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as SentCommand;
    expect(update.input.UpdateExpression).toMatch(/REMOVE GSI2PK, GSI2SK/);
    expect(update.input.ExpressionAttributeValues[':assignedTo']).toBeNull();
    expect(update.input.ExpressionAttributeValues[':assignedToName']).toBeNull();
  });

  it('updateTask nextDue change keeps GSI1SK and GSI2SK in sync', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    const newDue = '2026-06-15T00:00:00.000Z';
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: { ...baseTask, nextDue: newDue },
    });
    await updateTask('hh-1', 't1', { nextDue: newDue });
    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as SentCommand;
    expect(update.input.ExpressionAttributeValues[':gsi1sk']).toBe(newDue);
    expect(update.input.ExpressionAttributeValues[':gsi2sk']).toBe(newDue);
  });

  it('updateTask reassignment + nextDue uses the incoming nextDue for GSI2SK (no extra read)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member',
      joinedAt: '',
    });
    const newDue = '2026-07-01T00:00:00.000Z';
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: { ...baseTask, assignedTo: 'user-2', nextDue: newDue },
    });
    await updateTask('hh-1', 't1', { assignedTo: 'user-2', nextDue: newDue });
    // Single Update — no Get needed because nextDue came in with the input.
    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(1);
    const update = calls[0][0] as unknown as SentCommand;
    expect(update.input.ExpressionAttributeValues[':gsi2sk']).toBe(newDue);
  });

  it('completeTask returns null when task missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const result = await completeTask('hh-1', 't1', 'user-1', 'Test');
    expect(result).toBeNull();
  });

  it('completeTask advances the task first, then records a completion', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: baseTask })
      .mockResolvedValueOnce({
        Attributes: { ...baseTask, lastCompleted: 'now', nextDue: 'later' },
      })
      .mockResolvedValueOnce({});
    const result = await completeTask('hh-1', 't1', 'user-1', 'Test', 'note');
    expect(result?.lastCompleted).toBe('now');
    const kinds = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => (c[0] as unknown as SentCommand).kind);
    // Get → conditional Update → completion Put (in that order, so a failed
    // condition never leaves a stray completion record).
    expect(kinds).toEqual(['Get', 'Update', 'Put']);
  });

  it('completeTask guards with attribute_exists + expected nextDue and syncs GSI keys', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: baseTask })
      .mockResolvedValueOnce({ Attributes: { ...baseTask } })
      .mockResolvedValueOnce({});
    await completeTask('hh-1', 't1', 'user-1', 'Test');
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as SentCommand;
    expect(update.input.ConditionExpression).toBe(
      'attribute_exists(PK) AND #nextDue = :expectedNextDue'
    );
    expect(update.input.ExpressionAttributeValues[':expectedNextDue']).toBe(baseTask.nextDue);
    expect(update.input.UpdateExpression).toContain('GSI1SK = :nextDue');
    expect(update.input.UpdateExpression).toContain('GSI2SK = :nextDue');
  });

  it('completeTask double-completion is an idempotent no-op returning current state', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    const err = new Error('conditional');
    err.name = 'ConditionalCheckFailedException';
    const alreadyCompleted = {
      ...baseTask,
      lastCompleted: '2026-05-01T08:00:00.000Z',
      nextDue: '2026-05-08T00:00:00.000Z',
    };
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: baseTask }) // stale read
      .mockRejectedValueOnce(err) // concurrent completion won the race
      .mockResolvedValueOnce({ Item: alreadyCompleted }); // re-read current state
    const result = await completeTask('hh-1', 't1', 'user-1', 'Test');
    expect(result?.nextDue).toBe('2026-05-08T00:00:00.000Z');
    // No completion Put — the loser of the race must not write a duplicate.
    const kinds = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => (c[0] as unknown as SentCommand).kind);
    expect(kinds).toEqual(['Get', 'Update', 'Get']);
  });

  it('completeTask on a concurrently-deleted task returns null and writes nothing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    const err = new Error('conditional');
    err.name = 'ConditionalCheckFailedException';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: baseTask })
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: undefined }); // deleted
    const result = await completeTask('hh-1', 't1', 'user-1', 'Test');
    expect(result).toBeNull();
    const kinds = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => (c[0] as unknown as SentCommand).kind);
    expect(kinds).not.toContain('Put');
  });

  it('snoozeTask on a future task pushes nextDue forward from the current due date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00.000Z'));
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { snoozeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { ...baseTask, nextDue: '2026-05-01T00:00:00.000Z' } })
      .mockResolvedValueOnce({
        Attributes: { ...baseTask, nextDue: '2026-05-04T00:00:00.000Z' },
      });
    await snoozeTask('hh-1', 't1', 3);
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as SentCommand;
    expect(update.input.ExpressionAttributeValues[':nextDue']).toBe('2026-05-04T00:00:00.000Z');
  });

  it('snoozeTask on an OVERDUE task bases the new due date on now (clears overdue)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { snoozeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      // 40 days overdue — old behavior would produce 2026-05-04, still overdue.
      .mockResolvedValueOnce({ Item: { ...baseTask, nextDue: '2026-05-01T00:00:00.000Z' } })
      .mockResolvedValueOnce({ Attributes: { ...baseTask } });
    await snoozeTask('hh-1', 't1', 3);
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as SentCommand;
    expect(update.input.ExpressionAttributeValues[':nextDue']).toBe('2026-06-13T00:00:00.000Z');
    // GSI2SK rides along with nextDue.
    expect(update.input.UpdateExpression).toContain('GSI2SK = :nextDue');
  });

  it('snoozeTask returns null when task is missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { snoozeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    expect(await snoozeTask('hh-1', 't1', 3)).toBeNull();
  });

  it('getHouseholdActivity queries GSI1 newest-first', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getHouseholdActivity } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        {
          entityType: 'TaskCompletion',
          id: 'c1',
          householdId: 'hh-1',
          plantId: 'p1',
          taskId: 't1',
          taskType: 'water',
          completedBy: 'u',
          completedByName: 'A',
          completedAt: '2026-05-02',
          notes: null,
        },
      ],
    });
    const items = await getHouseholdActivity('hh-1');
    expect(items).toHaveLength(1);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ScanIndexForward: boolean; KeyConditionExpression: string };
    };
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.KeyConditionExpression).toContain('GSI1PK');
  });

  it('getYearInReview pages past 200 completions instead of undercounting', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getYearInReview } = await import('../../../src/services/taskService.js');
    const completion = (i: number) => ({
      entityType: 'TaskCompletion',
      completedBy: 'u1',
      completedByName: 'A',
      taskType: 'water',
      plantId: `p${i % 3}`,
    });
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: Array.from({ length: 200 }, (_, i) => completion(i)),
        LastEvaluatedKey: { k: 1 },
      })
      .mockResolvedValueOnce({
        Items: Array.from({ length: 50 }, (_, i) => completion(i)),
      });
    const review = await getYearInReview('hh-1', 2026);
    expect(review.totalCompletions).toBe(250);
    expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(2);
  });

  it('deleteTask issues a DeleteCommand', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await deleteTask('hh-1', 't1');
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as { kind: string };
    expect(cmd.kind).toBe('Delete');
  });

  describe('claimTask / unclaimTask', () => {
    const bob = {
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member' as const,
      joinedAt: '',
    };

    it('claimTask conditionally assigns the caller and syncs GSI2', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      const activity = await import('../../../src/services/activity.js');
      const { claimTask } = await import('../../../src/services/taskService.js');
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(bob);
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: { ...baseTask, assignedTo: 'user-2', assignedToName: 'Bob' },
      });

      const result = await claimTask('hh-1', 't1', 'user-2');
      expect(result).toMatchObject({ assignedTo: 'user-2', assignedToName: 'Bob' });

      const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as SentCommand;
      // Exists AND unassigned, atomically — the whole point of the feature.
      expect(update.input.ConditionExpression).toBe(
        'attribute_exists(PK) AND (attribute_not_exists(#assignedTo) OR #assignedTo = :null)'
      );
      expect(update.input.ExpressionAttributeValues[':gsi2pk']).toBe(
        'HOUSEHOLD#hh-1#ASSIGNEE#user-2'
      );
      // GSI2SK copies the live nextDue attribute (no read-modify-write).
      expect(update.input.UpdateExpression).toContain('GSI2SK = #nextDue');
      expect(activity.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.claimed', actorId: 'user-2', actorName: 'Bob' })
      );
    });

    it('claim race: conditional failure on a still-existing task → already_claimed', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      const activity = await import('../../../src/services/activity.js');
      const { claimTask } = await import('../../../src/services/taskService.js');
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(bob);
      const err = new Error('conditional');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send)
        .mockRejectedValueOnce(err) // someone else won the claim race
        .mockResolvedValueOnce({ Item: { ...baseTask, assignedTo: 'user-9' } }); // re-read

      const result = await claimTask('hh-1', 't1', 'user-2');
      expect(result).toBe('already_claimed');
      expect(activity.recordActivity).not.toHaveBeenCalled();
    });

    it('claim of a concurrently-deleted task returns null (404)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { claimTask } = await import('../../../src/services/taskService.js');
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(bob);
      const err = new Error('conditional');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send)
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ Item: undefined });
      expect(await claimTask('hh-1', 't1', 'user-2')).toBeNull();
    });

    it('unclaimTask clears assignment + GSI2 only for the current assignee', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { unclaimTask } = await import('../../../src/services/taskService.js');
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(bob);
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: { ...baseTask, assignedTo: null, assignedToName: null },
      });

      const result = await unclaimTask('hh-1', 't1', 'user-2');
      expect(result).toMatchObject({ assignedTo: null });
      const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as SentCommand;
      expect(update.input.ConditionExpression).toBe(
        'attribute_exists(PK) AND #assignedTo = :userId'
      );
      expect(update.input.ExpressionAttributeValues[':userId']).toBe('user-2');
      expect(update.input.UpdateExpression).toMatch(/REMOVE GSI2PK, GSI2SK/);
    });

    it('unclaim by a non-assignee returns not_assignee (403)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { unclaimTask } = await import('../../../src/services/taskService.js');
      const err = new Error('conditional');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send)
        .mockRejectedValueOnce(err)
        // Task exists but is assigned to someone else.
        .mockResolvedValueOnce({ Item: { ...baseTask, assignedTo: 'user-9' } });
      expect(await unclaimTask('hh-1', 't1', 'user-2')).toBe('not_assignee');
    });

    it('unclaim of a missing task returns null (404)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { unclaimTask } = await import('../../../src/services/taskService.js');
      const err = new Error('conditional');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send)
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ Item: undefined });
      expect(await unclaimTask('hh-1', 't1', 'user-2')).toBeNull();
    });
  });

  describe('vacation windows', () => {
    const NOW = new Date('2026-06-10T12:00:00.000Z');
    const vacationRow = {
      entityType: 'VacationWindow',
      householdId: 'hh-1',
      userId: 'user-away',
      coveredBy: 'user-cover',
      coveredByName: 'Cover',
      startDate: '2026-06-01T00:00:00.000Z',
      endDate: '2026-06-20T23:59:59.999Z',
      createdBy: 'user-away',
      createdAt: '2026-05-30T00:00:00.000Z',
    };

    it('setVacationWindow writes the VACATION row with a TTL past endDate', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { setVacationWindow } = await import('../../../src/services/taskService.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});
      const window = await setVacationWindow(
        'hh-1',
        {
          userId: 'user-away',
          coveredBy: 'user-cover',
          coveredByName: 'Cover',
          startDate: '2026-06-01T00:00:00.000Z',
          endDate: '2026-06-20T23:59:59.999Z',
        },
        'user-away'
      );
      expect(window.coveredBy).toBe('user-cover');
      const put = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as SentCommand;
      expect(put.input.Item.PK).toBe('HOUSEHOLD#hh-1');
      expect(put.input.Item.SK).toBe('VACATION#user-away');
      // TTL is a few days PAST endDate — reads filter by endDate, the TTL
      // only garbage-collects.
      expect(put.input.Item.ttl).toBeGreaterThan(Date.parse(window.endDate) / 1000);
    });

    it('listVacationWindows filters out windows that already ended (auto-expiry)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { listVacationWindows } = await import('../../../src/services/taskService.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          vacationRow,
          { ...vacationRow, userId: 'user-old', endDate: '2026-06-01T00:00:00.000Z' },
        ],
      });
      const windows = await listVacationWindows('hh-1', NOW);
      expect(windows.map((w) => w.userId)).toEqual(['user-away']);
    });

    it('getActiveVacationMap excludes future windows', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { getActiveVacationMap } = await import('../../../src/services/taskService.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          vacationRow, // active now
          {
            ...vacationRow,
            userId: 'user-later',
            startDate: '2026-07-01T00:00:00.000Z',
            endDate: '2026-07-10T00:00:00.000Z',
          },
        ],
      });
      const map = await getActiveVacationMap('hh-1', NOW);
      expect([...map.keys()]).toEqual(['user-away']);
    });

    it('annotateTasksWithCoverage adds effectiveAssignee/coveringFor without rewriting assignedTo', async () => {
      const { annotateTasksWithCoverage } = await import('../../../src/services/taskService.js');
      const away = {
        ...baseTask,
        id: 't-away',
        assignedTo: 'user-away',
        assignedToName: 'Alice',
      };
      const other = { ...baseTask, id: 't-other', assignedTo: 'user-x', assignedToName: 'X' };
      const unassigned = { ...baseTask, id: 't-un' };
      const map = new Map([
        [
          'user-away',
          {
            householdId: 'hh-1',
            userId: 'user-away',
            coveredBy: 'user-cover',
            coveredByName: 'Cover',
            startDate: '',
            endDate: '',
            createdBy: '',
            createdAt: '',
          },
        ],
      ]);
      const [a, b, c] = annotateTasksWithCoverage([away, other, unassigned], map);
      expect(a).toMatchObject({
        assignedTo: 'user-away', // NOT rewritten — auto-revert is the point
        effectiveAssignee: 'user-cover',
        effectiveAssigneeName: 'Cover',
        coveringFor: 'Alice',
      });
      expect(b.effectiveAssignee).toBeUndefined();
      expect(c.effectiveAssignee).toBeUndefined();
    });

    it('annotateTasksWithCoverage does not claim a cover who is themselves away', async () => {
      const { annotateTasksWithCoverage } = await import('../../../src/services/taskService.js');
      const task = {
        ...baseTask,
        id: 't-a',
        assignedTo: 'user-a',
        assignedToName: 'Alice',
      };
      // A → covered by B, but B → covered by C (B is also on vacation).
      const map = new Map([
        [
          'user-a',
          {
            householdId: 'hh-1',
            userId: 'user-a',
            coveredBy: 'user-b',
            coveredByName: 'Bob',
            startDate: '',
            endDate: '',
            createdBy: '',
            createdAt: '',
          },
        ],
        [
          'user-b',
          {
            householdId: 'hh-1',
            userId: 'user-b',
            coveredBy: 'user-c',
            coveredByName: 'Cara',
            startDate: '',
            endDate: '',
            createdBy: '',
            createdAt: '',
          },
        ],
      ]);
      const [a] = annotateTasksWithCoverage([task], map);
      expect(a.effectiveAssignee).toBeUndefined();
      expect(a.effectiveAssigneeName).toBeUndefined();
      expect(a.coveringFor).toBeUndefined();
      expect(a.assignedTo).toBe('user-a'); // still not rewritten
    });

    it('getTasks annotates tasks whose assignee has an active window', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { getTasks } = await import('../../../src/services/taskService.js');
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({
          Items: [
            { ...baseTask, id: 't1', assignedTo: 'user-away', assignedToName: 'Alice' },
            { ...baseTask, id: 't2' },
          ],
        })
        .mockResolvedValueOnce({ Items: activePlantRows })
        .mockResolvedValueOnce({ Items: [vacationRow] }); // vacation lookup
      const tasks = await getTasks('hh-1');
      const t1 = tasks.find((t) => t.id === 't1')!;
      expect(t1.effectiveAssignee).toBe('user-cover');
      expect(t1.coveringFor).toBe('Alice');
      expect(tasks.find((t) => t.id === 't2')!.effectiveAssignee).toBeUndefined();
    });

    it('deleteVacationWindow returns false when no window exists', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { deleteVacationWindow } = await import('../../../src/services/taskService.js');
      const err = new Error('conditional');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send).mockRejectedValueOnce(err);
      expect(await deleteVacationWindow('hh-1', 'user-away')).toBe(false);
    });
  });
});
