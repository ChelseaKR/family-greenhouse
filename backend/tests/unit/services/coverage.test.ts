import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (i) {
    return { input: i, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../src/services/plantService.js', () => ({
  getPlants: vi.fn(),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  listVacationWindows: vi.fn(),
}));

const completion = (plantId: string, completedBy: string) => ({
  entityType: 'TaskCompletion',
  plantId,
  completedBy,
});

describe('listAllCompletions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('follows LastEvaluatedKey to exhaustion and keeps only completion rows', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          completion('p1', 'u1'),
          // ActivityEvent rows share the partition and must not count.
          { entityType: 'ActivityEvent', type: 'task.claimed', plantId: 'p1', actorId: 'u2' },
        ],
        LastEvaluatedKey: { PK: 'x', SK: 'y' },
      } as never)
      .mockResolvedValueOnce({ Items: [completion('p2', 'u2')] } as never);

    const { listAllCompletions } = await import('../../../src/services/coverage.js');
    const rows = await listAllCompletions('hh');

    expect(rows).toEqual([
      { plantId: 'p1', completedBy: 'u1' },
      { plantId: 'p2', completedBy: 'u2' },
    ]);
    expect(dynamodb.send).toHaveBeenCalledTimes(2);
    const second = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: Record<string, unknown>;
    };
    expect(second.input.ExclusiveStartKey).toEqual({ PK: 'x', SK: 'y' });
  });

  it('queries the whole activity partition with no date bound, projected to three attributes', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);
    const { listAllCompletions } = await import('../../../src/services/coverage.js');
    await listAllCompletions('hh-9');

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: Record<string, unknown>;
    };
    expect(call.input.IndexName).toBe('GSI1');
    expect(call.input.KeyConditionExpression).toBe('GSI1PK = :pk');
    expect(call.input.ExpressionAttributeValues).toEqual({ ':pk': 'HOUSEHOLD#hh-9#ACTIVITY' });
    expect(call.input.ProjectionExpression).toBe('#et, #plant, #by');
  });

  it('propagates a read failure instead of returning an empty history', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const { listAllCompletions } = await import('../../../src/services/coverage.js');
    await expect(listAllCompletions('hh')).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});

describe('getCoverageReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assembles roster, active plants, pending windows and all-time history into one report', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');

    vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce([
      { householdId: 'hh', userId: 'u1', name: 'Priya', email: 'p@x', role: 'admin', joinedAt: '' },
      { householdId: 'hh', userId: 'u2', name: 'Sam', email: 's@x', role: 'member', joinedAt: '' },
    ]);
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([
      { id: 'p1', name: 'Monstera' } as never,
      { id: 'p2', name: 'Fern' } as never,
    ]);
    vi.mocked(taskService.listVacationWindows).mockResolvedValueOnce([
      {
        householdId: 'hh',
        userId: 'u1',
        coveredBy: 'u2',
        coveredByName: 'Sam',
        startDate: '2026-09-10T00:00:00.000Z',
        endDate: '2026-09-17T00:00:00.000Z',
        createdBy: 'u1',
        createdAt: '',
      },
    ]);
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [completion('p1', 'u1'), completion('p2', 'u1'), completion('p2', 'u2')],
    } as never);

    const { getCoverageReport } = await import('../../../src/services/coverage.js');
    const now = new Date('2026-09-03T00:00:00.000Z');
    const report = await getCoverageReport('hh', now);

    // Plants are read with the default (active-only) filter.
    expect(plantService.getPlants).toHaveBeenCalledWith('hh');
    expect(taskService.listVacationWindows).toHaveBeenCalledWith('hh', now);
    expect(report.memberCount).toBe(2);
    expect(report.soleCaregiverPlants.map((p) => p.plantName)).toEqual(['Monstera']);
    expect(report.awayRisks[0]).toMatchObject({
      name: 'Priya',
      coveredByName: 'Sam',
      uncoveredPlantCount: 1,
      uncoveredPlants: [{ plantId: 'p1', plantName: 'Monstera' }],
    });
    expect(report.generatedAt).toBe(now.toISOString());
  });

  it('rejects the whole report when any one read fails — never a partial "0 at risk"', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');

    vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([]);
    vi.mocked(plantService.getPlants).mockRejectedValueOnce(new Error('plants read failed'));
    vi.mocked(taskService.listVacationWindows).mockResolvedValue([]);
    vi.mocked(dynamodb.send).mockResolvedValue({ Items: [] } as never);

    const { getCoverageReport } = await import('../../../src/services/coverage.js');
    await expect(getCoverageReport('hh')).rejects.toThrow('plants read failed');
  });
});
