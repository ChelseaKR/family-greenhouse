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

vi.mock('../../../src/services/activity.js', () => ({
  recordActivity: vi.fn(async () => undefined),
}));

const input = {
  plantId: '11111111-1111-4111-8111-111111111111',
  type: 'custom' as const,
  customType: '→ Living room',
  frequency: 365,
};

type Sent = { kind: string; input: Record<string, unknown> };

// Seasonal Move Day hands each move to a member as a SUGGESTION: the task
// carries `assignmentSource: 'move_day'` so any other member can take it
// over, exactly like a space's usual-caregiver default.
describe('createTask with a Move Day assignee', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the move_day source and the assignee index when the member exists', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getMemberByUserId } = await import('../../../src/services/householdService.js');
    const { createTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getMemberByUserId).mockResolvedValue({ name: 'Ada' } as never);
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const task = await createTask(input, 'hh-1', 'u-actor', 'Monstera', {
      defaultAssigneeId: 'u-a',
      defaultAssignmentSource: 'move_day',
    });

    expect(task).toMatchObject({
      assignedTo: 'u-a',
      assignedToName: 'Ada',
      assignmentSource: 'move_day',
      customType: '→ Living room',
      frequency: 365,
    });
    const put = (vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as Sent).input;
    expect(put.Item).toMatchObject({
      assignmentSource: 'move_day',
      GSI2PK: 'HOUSEHOLD#hh-1#ASSIGNEE#u-a',
    });
  });

  it('drops a departed Move Day assignee instead of refusing to create the task', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getMemberByUserId } = await import('../../../src/services/householdService.js');
    const { createTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getMemberByUserId).mockResolvedValue(null);
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const task = await createTask(input, 'hh-1', 'u-actor', 'Monstera', {
      defaultAssigneeId: 'u-gone',
      defaultAssignmentSource: 'move_day',
    });
    expect(task).toMatchObject({ assignedTo: null, assignmentSource: null });
  });

  it('still defaults a plain default assignee to space_default', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getMemberByUserId } = await import('../../../src/services/householdService.js');
    const { createTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getMemberByUserId).mockResolvedValue({ name: 'Ada' } as never);
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    const task = await createTask(input, 'hh-1', 'u-actor', 'Monstera', {
      defaultAssigneeId: 'u-a',
    });
    expect(task.assignmentSource).toBe('space_default');
  });
});

describe('claimTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets another member take over a Move Day assignment atomically', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getMemberByUserId } = await import('../../../src/services/householdService.js');
    const { claimTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getMemberByUserId).mockResolvedValue({ name: 'Ben' } as never);
    vi.mocked(dynamodb.send).mockResolvedValue({
      Attributes: {
        id: 't-1',
        householdId: 'hh-1',
        plantId: 'p-1',
        plantName: 'Monstera',
        type: 'custom',
        customType: '→ Living room',
        frequency: 365,
        nextDue: '2026-10-14T20:00:00.000Z',
        assignedTo: 'u-b',
        assignedToName: 'Ben',
        assignmentSource: null,
      },
    } as never);

    const result = await claimTask('hh-1', 't-1', 'u-b');
    expect(result).toMatchObject({ id: 't-1', assignedTo: 'u-b' });

    const update = (vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as Sent).input;
    expect(update.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(#assignedTo) OR #assignedTo = :null OR #assignmentSource = :spaceDefault OR #assignmentSource = :moveDay)'
    );
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':spaceDefault': 'space_default',
      ':moveDay': 'move_day',
    });
  });
});
