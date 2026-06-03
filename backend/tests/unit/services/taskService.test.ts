import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  GetCommand: vi.fn((input) => ({ input, kind: 'Get' })),
  QueryCommand: vi.fn((input) => ({ input, kind: 'Query' })),
  DeleteCommand: vi.fn((input) => ({ input, kind: 'Delete' })),
  UpdateCommand: vi.fn((input) => ({ input, kind: 'Update' })),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(),
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

describe('taskService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        { ...baseTask, id: 't1', plantId: 'p1' },
        { ...baseTask, id: 't2', plantId: 'p2' },
      ],
    });
    const tasks = await getTasks('hh-1', { plantId: 'p1' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('getTasks applies overdue filter in memory', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        { ...baseTask, id: 't1', nextDue: '2000-01-01T00:00:00.000Z' },
        { ...baseTask, id: 't2', nextDue: '2099-01-01T00:00:00.000Z' },
      ],
    });
    const tasks = await getTasks('hh-1', { overdue: true });
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('getUpcomingTasks queries GSI1 and filters non-task items', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getUpcomingTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        { ...baseTask, id: 't1', entityType: 'Task', nextDue: '2026-05-02T00:00:00.000Z' },
        { ...baseTask, id: 't2', entityType: 'Task', nextDue: '2026-05-01T00:00:00.000Z' },
        { entityType: 'Other' },
      ],
    });
    const tasks = await getUpcomingTasks('hh-1');
    expect(tasks.map((t) => t.id)).toEqual(['t2', 't1']);
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

  it('updateTask returns null when ConditionExpression rejects (no Attributes)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { updateTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: undefined });
    const result = await updateTask('hh-1', 't1', { frequency: 14 });
    expect(result).toBeNull();
  });

  it('completeTask returns null when task missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    const result = await completeTask('hh-1', 't1', 'user-1', 'Test');
    expect(result).toBeNull();
  });

  it('completeTask records a completion and updates the task', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: baseTask })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Attributes: { ...baseTask, lastCompleted: 'now', nextDue: 'later' },
      });
    const result = await completeTask('hh-1', 't1', 'user-1', 'Test', 'note');
    expect(result?.lastCompleted).toBe('now');
    expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(3);
  });

  it('snoozeTask pushes nextDue forward by N days', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { snoozeTask } = await import('../../../src/services/taskService.js');
    const before = '2026-05-01T00:00:00.000Z';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { ...baseTask, nextDue: before } })
      .mockResolvedValueOnce({
        Attributes: { ...baseTask, nextDue: '2026-05-04T00:00:00.000Z' },
      });
    const result = await snoozeTask('hh-1', 't1', 3);
    expect(result?.nextDue).toBe('2026-05-04T00:00:00.000Z');
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

  it('deleteTask issues a DeleteCommand', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { deleteTask } = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await deleteTask('hh-1', 't1');
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as { kind: string };
    expect(cmd.kind).toBe('Delete');
  });
});
