/**
 * The sitter task lookahead honours the LINK'S window, not a fixed seven
 * days. Before this, a household that set a three-week sitter link had its
 * sitter shown only the first week of work — the window was modelled on the
 * link (`startsAt` / `expiresAt`) and enforced for access, but the task view
 * ignored it.
 */
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
  ListObjectsV2Command: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({ getMemberByUserId: vi.fn() }));
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn() }));
vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));
vi.mock('../../../src/services/spaceService.js', () => ({ getSpaces: vi.fn() }));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-03T12:00:00.000Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY_MS).toISOString();

function task(id: string, nextDue: string) {
  return {
    id,
    householdId: 'hh-1',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue,
    assignedTo: null,
    assignedToName: null,
    assignmentSource: null,
    notes: 'private',
    createdBy: 'u1',
    createdAt: inDays(-30),
  };
}

async function load() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const plantService = await import('../../../src/services/plantService.js');
  const spaceService = await import('../../../src/services/spaceService.js');
  const taskService = await import('../../../src/services/taskService.js');
  return { dynamodb, plantService, spaceService, taskService };
}

const TASKS = [
  task('overdue', inDays(-2)),
  task('today', inDays(0)),
  task('day-5', inDays(5)),
  task('day-12', inDays(12)),
  task('day-20', inDays(20)),
  task('day-40', inDays(40)),
];

describe('taskService.getSitterTasks — lookahead is the link window', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { dynamodb, plantService, spaceService } = await load();
    // First DynamoDB read is the task partition; every later read (vacation
    // coverage lookup) is empty. Plants and spaces come from their services.
    let calls = 0;
    vi.mocked(dynamodb.send).mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? { Items: TASKS } : { Items: [] };
    });
    vi.mocked(plantService.getPlants).mockResolvedValue([
      {
        id: 'p1',
        householdId: 'hh-1',
        name: 'Monstera',
        spaceId: 's1',
        placementNote: 'east window',
        status: 'active',
      },
    ] as never);
    vi.mocked(spaceService.getSpaces).mockResolvedValue([
      { id: 's1', householdId: 'hh-1', name: 'Living Room' },
    ] as never);
  });

  it('shows everything due up to a three-week link end, not just seven days', async () => {
    const { taskService } = await load();
    const tasks = await taskService.getSitterTasks('hh-1', inDays(21), NOW);
    expect(tasks.map((t) => t.taskId)).toEqual(['overdue', 'today', 'day-5', 'day-12', 'day-20']);
  });

  it('keeps a short link short: a 3-day window hides work due after it', async () => {
    const { taskService } = await load();
    const tasks = await taskService.getSitterTasks('hh-1', inDays(3), NOW);
    expect(tasks.map((t) => t.taskId)).toEqual(['overdue', 'today']);
  });

  it('shows a 60-day window in full, sorted soonest first, with overdue flagged', async () => {
    const { taskService } = await load();
    const tasks = await taskService.getSitterTasks('hh-1', inDays(60), NOW);
    expect(tasks.map((t) => t.taskId)).toEqual([
      'overdue',
      'today',
      'day-5',
      'day-12',
      'day-20',
      'day-40',
    ]);
    expect(tasks[0].overdue).toBe(true);
    expect(tasks[1].overdue).toBe(false);
  });

  it('still shows overdue and due-today work when the window end is already behind now', async () => {
    const { taskService } = await load();
    // A defensive case: access is refused after expiresAt, but if a caller
    // ever passes a stale end the sitter must not see an empty list that
    // reads as "nothing to do".
    const tasks = await taskService.getSitterTasks('hh-1', inDays(-1), NOW);
    expect(tasks.map((t) => t.taskId)).toEqual(['overdue', 'today']);
  });

  it('projects only the PII-free sitter shape (no task notes, no assignee)', async () => {
    const { taskService } = await load();
    const [first] = await taskService.getSitterTasks('hh-1', inDays(21), NOW);
    expect(Object.keys(first).sort()).toEqual(
      ['dueDate', 'overdue', 'placementNote', 'plantName', 'spaceName', 'taskType', 'taskId'].sort()
    );
    expect(first.spaceName).toBe('Living Room');
    expect(first.placementNote).toBe('east window');
    expect(JSON.stringify(first)).not.toContain('private');
  });

  it('sitterWindowCutoff returns the window end when it is ahead of now, else now', async () => {
    const { taskService } = await load();
    expect(taskService.sitterWindowCutoff(inDays(10), NOW)).toBe(inDays(10));
    expect(taskService.sitterWindowCutoff(inDays(-10), NOW)).toBe(NOW.toISOString());
  });
});
