import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (i) {
    return { input: i, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (i) {
    return { input: i, kind: 'Query' };
  }),
  DeleteCommand: vi.fn(function (i) {
    return { input: i, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (i) {
    return { input: i, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(),
}));

const completion = (overrides: Record<string, unknown>) => ({
  entityType: 'TaskCompletion',
  id: 'c',
  householdId: 'hh',
  plantId: 'p1',
  taskId: 't1',
  taskType: 'water',
  completedBy: 'u1',
  completedByName: 'Alice',
  completedAt: '2026-04-25T12:00:00.000Z',
  notes: null,
  ...overrides,
});

describe('getYearInReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates by member, type, and plant', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        completion({
          id: 'c1',
          completedBy: 'u1',
          completedByName: 'Alice',
          taskType: 'water',
          plantId: 'p1',
        }),
        completion({
          id: 'c2',
          completedBy: 'u1',
          completedByName: 'Alice',
          taskType: 'water',
          plantId: 'p2',
        }),
        completion({
          id: 'c3',
          completedBy: 'u2',
          completedByName: 'Bob',
          taskType: 'fertilize',
          plantId: 'p1',
        }),
        completion({
          id: 'c4',
          completedBy: 'u1',
          completedByName: 'Alice',
          taskType: 'water',
          plantId: 'p1',
        }),
        // Non-completion item should be skipped.
        { entityType: 'Other', completedBy: 'x' },
      ],
    });
    const { getYearInReview } = await import('../../../src/services/taskService.js');
    const review = await getYearInReview('hh', 2026);

    expect(review.year).toBe(2026);
    expect(review.totalCompletions).toBe(4);
    expect(review.byMember[0]).toEqual({ userId: 'u1', name: 'Alice', count: 3 });
    expect(review.byTaskType[0].type).toBe('water');
    expect(review.byTaskType[0].count).toBe(3);
    expect(review.topPlants[0]).toEqual({ plantId: 'p1', count: 3 });
  });

  it('passes the year window as a between key condition', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] });
    const { getYearInReview } = await import('../../../src/services/taskService.js');
    await getYearInReview('hh', 2026);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(cmd.input.ExpressionAttributeValues[':start']).toBe('2026-01-01T00:00:00.000Z');
    expect(cmd.input.ExpressionAttributeValues[':end']).toBe('2027-01-01T00:00:00.000Z');
  });
});
