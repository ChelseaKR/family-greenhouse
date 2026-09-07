import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

// Read by the seasonal-cadence resolver to get the household's hemisphere, and
// ONLY for a plant that has at least one seasonally-scheduled task. Mocked
// separately from `dynamodb.send` so it cannot consume a queued completion-read
// response and quietly change what the drift tests are measuring.
vi.mock('../../../src/services/householdService.js', () => ({
  getHousehold: vi.fn(async () => null),
}));

const NOW = new Date('2026-09-03T12:00:00.000Z');

function completionRow(overrides: Record<string, unknown> = {}) {
  return {
    entityType: 'TaskCompletion',
    id: 'c-sam',
    taskId: 't-1',
    taskType: 'water',
    completedBy: 'user-sam',
    completedByName: 'Sam',
    completedAt: '2026-09-03T08:00:00.000Z',
    ...overrides,
  };
}

describe('doubleCare service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findRecentDuplicate', () => {
    it('queries the plant partition from the window start and reports the duplicate', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { findRecentDuplicate } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [completionRow()] } as never);

      const check = await findRecentDuplicate({
        householdId: 'hh-1',
        plantId: 'p-1',
        taskId: 't-1',
        taskType: 'water',
        actorId: 'user-me',
        now: NOW,
      });

      expect(check).toEqual({
        status: 'duplicate',
        duplicate: expect.objectContaining({
          completionId: 'c-sam',
          completedByName: 'Sam',
          sameTask: true,
          windowHours: 24,
        }),
      });
      const call = vi.mocked(dynamodb.send).mock.calls[0][0] as { input: Record<string, unknown> };
      expect(call.input).toMatchObject({
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': 'HOUSEHOLD#hh-1#PLANT#p-1',
          ':lo': 'COMPLETION#2026-09-02T12:00:00.000Z',
          ':hi': 'COMPLETION#~',
        },
        ScanIndexForward: false,
      });
    });

    it('is clear when the only completions in the window are the actor’s own', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { findRecentDuplicate } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [completionRow({ completedBy: 'user-me' })],
      } as never);

      const check = await findRecentDuplicate({
        householdId: 'hh-1',
        plantId: 'p-1',
        taskId: 't-1',
        taskType: 'water',
        actorId: 'user-me',
        now: NOW,
      });
      expect(check).toEqual({ status: 'clear' });
    });

    it('reports unavailable — never clear — when the log cannot be read', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { findRecentDuplicate } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));

      const check = await findRecentDuplicate({
        householdId: 'hh-1',
        plantId: 'p-1',
        taskId: 't-1',
        taskType: 'water',
        actorId: 'user-me',
        now: NOW,
      });
      expect(check).toEqual({ status: 'unavailable' });
    });
  });

  describe('countConfirmedDuplicatesThisMonth', () => {
    it('counts tagged completions across pages and ignores activity events', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { countConfirmedDuplicatesThisMonth } =
        await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({
          Items: [
            completionRow({ id: 'c-1', duplicateOfCompletionId: 'c-0' }),
            completionRow({ id: 'c-2' }),
            { entityType: 'ActivityEvent', type: 'task.claimed', duplicateOfCompletionId: 'x' },
          ],
          LastEvaluatedKey: { PK: 'x', SK: 'y' },
        } as never)
        .mockResolvedValueOnce({
          Items: [completionRow({ id: 'c-3', duplicateOfCompletionId: 'c-2' })],
        } as never);

      const result = await countConfirmedDuplicatesThisMonth('hh-1', NOW);

      expect(result).toEqual({ status: 'ok', month: '2026-09', confirmedDuplicates: 2 });
      const first = vi.mocked(dynamodb.send).mock.calls[0][0] as { input: Record<string, unknown> };
      expect(first.input).toMatchObject({
        IndexName: 'GSI1',
        ExpressionAttributeValues: {
          ':pk': 'HOUSEHOLD#hh-1#ACTIVITY',
          ':start': '2026-09-01T00:00:00.000Z',
          ':end': NOW.toISOString(),
        },
      });
      const second = vi.mocked(dynamodb.send).mock.calls[1][0] as {
        input: Record<string, unknown>;
      };
      expect(second.input.ExclusiveStartKey).toEqual({ PK: 'x', SK: 'y' });
    });

    it('reports a real zero when the month has no tagged completions', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { countConfirmedDuplicatesThisMonth } =
        await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [completionRow()] } as never);
      expect(await countConfirmedDuplicatesThisMonth('hh-1', NOW)).toEqual({
        status: 'ok',
        month: '2026-09',
        confirmedDuplicates: 0,
      });
    });

    it('reports unavailable — never 0 — when the read fails', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { countConfirmedDuplicatesThisMonth } =
        await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('boom'));
      expect(await countConfirmedDuplicatesThisMonth('hh-1', NOW)).toEqual({
        status: 'unavailable',
      });
    });
  });

  describe('getScheduleDriftForPlant / ForTask', () => {
    const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`;

    it('groups one partition read by task and computes each reading', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { getScheduleDriftForPlant } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          ...[1, 12, 23].map((d, i) => completionRow({ id: `w${i}`, completedAt: at(d) })),
          completionRow({ id: 'w3', completedAt: '2026-09-03T09:00:00.000Z' }),
          completionRow({ id: 'f0', taskId: 't-2', taskType: 'fertilize', completedAt: at(1) }),
        ],
      } as never);

      const readings = await getScheduleDriftForPlant('hh-1', 'p-1', [
        { id: 't-1', frequency: 7 },
        { id: 't-2', frequency: 30 },
        { id: 't-3', frequency: 14 },
      ]);

      expect(readings).toHaveLength(3);
      expect(readings[0]).toMatchObject({
        taskId: 't-1',
        completionsConsidered: 4,
        drift: { suggestedFrequency: 11, exceedsThreshold: true },
        reason: null,
      });
      expect(readings[1]).toMatchObject({
        taskId: 't-2',
        completionsConsidered: 1,
        drift: null,
        reason: 'insufficient_completions',
      });
      expect(readings[2]).toMatchObject({
        taskId: 't-3',
        completionsConsidered: 0,
        drift: null,
        reason: 'insufficient_completions',
      });
      expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
    });

    it('measures a seasonal task against the cadence in force, not its base frequency', async () => {
      // Four completions 14 days apart, in November, for a household in Berlin
      // on a 7/14 profile. Against the base 7 that is +100% drift and earns a
      // "your schedule does not match reality" suggestion; against the winter
      // cadence the household actually set, it is no drift at all.
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      vi.mocked(householdService.getHousehold).mockResolvedValue({
        id: 'hh-1',
        name: 'Home',
        location: { city: 'Berlin', lat: 52.52, lon: 13.4 },
        createdAt: '',
        createdBy: 'u',
      } as never);
      const { getScheduleDriftForPlant } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [1, 15, 29, 43].map((offset, i) =>
          completionRow({
            id: `w${i}`,
            completedAt: new Date(Date.UTC(2026, 10, 1) + (offset - 1) * 86_400_000).toISOString(),
          })
        ),
      } as never);

      const [reading] = await getScheduleDriftForPlant('hh-1', 'p-1', [
        {
          id: 't-1',
          frequency: 7,
          seasonalCadences: [
            { season: 'spring', frequency: 7 },
            { season: 'summer', frequency: 7 },
            { season: 'autumn', frequency: 14 },
            { season: 'winter', frequency: 14 },
          ],
        },
      ]);

      expect(reading.scheduledIntervalDays).toBe(14);
      expect(reading.drift).toMatchObject({ driftPct: 0, exceedsThreshold: false });
    });

    it('reports schedule_unavailable, not a number, when the household read fails', async () => {
      // The history read fine; the interval to divide it by did not. Falling
      // back to the base frequency here would publish a confident wrong
      // percentage rather than an honest gap.
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      vi.mocked(householdService.getHousehold).mockRejectedValue(new Error('throttled'));
      const { getScheduleDriftForPlant } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          ...[1, 12, 23, 30].map((d, i) => completionRow({ id: `w${i}`, completedAt: at(d) })),
          ...[1, 12, 23, 30].map((d, i) =>
            completionRow({ id: `f${i}`, taskId: 't-2', completedAt: at(d) })
          ),
        ],
      } as never);

      const readings = await getScheduleDriftForPlant('hh-1', 'p-1', [
        { id: 't-1', frequency: 7, seasonalCadences: [{ season: 'autumn', frequency: 14 }] },
        // A task with no profile is unaffected: its interval was never in doubt,
        // so it still gets a real reading off the very same history read.
        { id: 't-2', frequency: 7 },
      ]);

      expect(readings[0]).toMatchObject({ drift: null, reason: 'schedule_unavailable' });
      expect(readings[1].reason).toBeNull();
      expect(readings[1].drift).not.toBeNull();
      expect(readings[1].scheduledIntervalDays).toBe(7);
    });

    it('does not read the household when no task on the plant is seasonal', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { getScheduleDriftForPlant } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);

      await getScheduleDriftForPlant('hh-1', 'p-1', [{ id: 't-1', frequency: 7 }]);
      expect(householdService.getHousehold).not.toHaveBeenCalled();
    });

    it('marks every task history_unavailable when the read fails (no 0% drift)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { getScheduleDriftForPlant } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('boom'));

      const readings = await getScheduleDriftForPlant('hh-1', 'p-1', [
        { id: 't-1', frequency: 7 },
        { id: 't-2', frequency: 30 },
      ]);
      expect(readings.map((r) => [r.taskId, r.drift, r.reason])).toEqual([
        ['t-1', null, 'history_unavailable'],
        ['t-2', null, 'history_unavailable'],
      ]);
    });

    it('getScheduleDriftForTask returns the single reading', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { getScheduleDriftForTask } = await import('../../../src/services/doubleCare.js');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);
      const reading = await getScheduleDriftForTask('hh-1', {
        id: 't-1',
        plantId: 'p-1',
        frequency: 7,
      });
      expect(reading).toMatchObject({
        taskId: 't-1',
        drift: null,
        reason: 'insufficient_completions',
      });
    });
  });
});
