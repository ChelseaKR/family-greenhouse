/**
 * Lapse detection (#478), and specifically the line it must never cross:
 * "we can see they stopped" and "we could not read their data" are different
 * answers. A careless version of this module marks every household lapsing the
 * day DynamoDB throttles, so most of what follows is about the reads that
 * FAILED rather than the ones that succeeded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  classifyEngagement,
  engagementLogFields,
  overdueFromAtRisk,
  readHouseholdEngagement,
  readLastCompletion,
  LAPSE_SILENCE_DAYS,
  type ClassifyEngagementInput,
  type OverdueRead,
} from '../../../src/services/householdLapse.js';
import type { AtRiskResult, AtRiskRow } from '../../../src/services/digestReport.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const someWork: OverdueRead = { status: 'ok', atRiskPlants: 3, oldestOverdueDays: 40 };

function classify(over: Partial<ClassifyEngagementInput> = {}) {
  return classifyEngagement({
    lastCompletion: { status: 'ok', completedAt: daysAgo(1) },
    overdue: someWork,
    householdStart: { status: 'ok', createdAt: daysAgo(200) },
    now: NOW,
    ...over,
  });
}

function completionItem(completedAt: unknown) {
  return { entityType: 'TaskCompletion', completedAt };
}
const eventItem = { entityType: 'ActivityEvent', createdAt: daysAgo(1) };

/** Queue one DynamoDB response per `send` call, in order. */
async function mockPages(pages: Array<Record<string, unknown>>) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  let i = 0;
  vi.mocked(dynamodb.send).mockImplementation(async () => {
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return page as never;
  });
}

describe('householdLapse — classification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls a household with a recent completion active', () => {
    const result = classify({ lastCompletion: { status: 'ok', completedAt: daysAgo(2) } });
    expect(result).toEqual({ status: 'active', daysSinceLastCompletion: 2, atRiskPlants: 3 });
  });

  it('calls silence plus unfinished work lapsing, and carries the numbers behind it', () => {
    const result = classify({
      lastCompletion: { status: 'ok', completedAt: daysAgo(45) },
    });
    expect(result).toEqual({
      status: 'lapsing',
      daysSinceLastCompletion: 45,
      atRiskPlants: 3,
      oldestOverdueDays: 40,
    });
  });

  it('holds the silence threshold exactly: one day short is still active', () => {
    expect(
      classify({ lastCompletion: { status: 'ok', completedAt: daysAgo(LAPSE_SILENCE_DAYS - 1) } })
        .status
    ).toBe('active');
    expect(
      classify({ lastCompletion: { status: 'ok', completedAt: daysAgo(LAPSE_SILENCE_DAYS) } })
        .status
    ).toBe('lapsing');
  });

  it('calls a quiet household that owes nothing idle, not lapsing', () => {
    // Quiet is only a problem when there is work waiting. A household that
    // marked its plants gone owes nobody anything.
    const result = classify({
      lastCompletion: { status: 'ok', completedAt: daysAgo(90) },
      overdue: { status: 'ok', atRiskPlants: 0, oldestOverdueDays: null },
    });
    expect(result).toEqual({ status: 'idle', daysSinceLastCompletion: 90 });
  });

  it('distinguishes a household that never started from one that drifted away', () => {
    const result = classify({
      lastCompletion: { status: 'none' },
      householdStart: { status: 'ok', createdAt: daysAgo(4) },
    });
    expect(result).toEqual({ status: 'never_active', householdAgeDays: 4, atRiskPlants: 3 });
    // Four days old is not a lapse, and must not be reported as one.
    expect(result.status).not.toBe('lapsing');
  });

  it('reports an unreadable household age as null, never as a household created today', () => {
    for (const householdStart of [{ status: 'missing' }, { status: 'unavailable' }] as const) {
      const result = classify({ lastCompletion: { status: 'none' }, householdStart });
      expect(result).toEqual({ status: 'never_active', householdAgeDays: null, atRiskPlants: 3 });
    }
  });

  it('never turns a failed completions read into a lapse', () => {
    for (const reason of ['completions_read_failed', 'completion_scan_incomplete'] as const) {
      const result = classify({ lastCompletion: { status: 'unavailable', reason } });
      expect(result).toEqual({ status: 'unavailable', reason });
    }
  });

  it('never turns a failed at-risk read into a lapse either', () => {
    const result = classify({
      lastCompletion: { status: 'ok', completedAt: daysAgo(90) },
      overdue: { status: 'unavailable' },
    });
    // 90 days of silence is real. How much work is waiting is not known, and
    // the second half of the definition cannot be assumed.
    expect(result).toEqual({ status: 'unavailable', reason: 'overdue_unreadable' });
  });

  it('reports the completions reason when both reads failed', () => {
    const result = classify({
      lastCompletion: { status: 'unavailable', reason: 'completions_read_failed' },
      overdue: { status: 'unavailable' },
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'completions_read_failed' });
  });

  it('refuses to date a completion whose timestamp does not parse', () => {
    const result = classify({ lastCompletion: { status: 'ok', completedAt: 'yesterday-ish' } });
    // Not "0 days ago" (which reads as engaged) and not "none" (which reads as
    // never started). Both are answers we do not have.
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'completion_timestamp_unreadable',
    });
  });

  it('clamps a future completion to zero rather than reporting negative silence', () => {
    const result = classify({
      lastCompletion: {
        status: 'ok',
        completedAt: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      },
    });
    expect(result).toEqual({ status: 'active', daysSinceLastCompletion: 0, atRiskPlants: 3 });
  });
});

describe('householdLapse — reading the newest completion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the newest completion, skipping the activity rows above it', async () => {
    await mockPages([{ Items: [eventItem, eventItem, completionItem(daysAgo(30))] }]);
    await expect(readLastCompletion('hh')).resolves.toEqual({
      status: 'ok',
      completedAt: daysAgo(30),
    });
  });

  it('pages past a full page that holds no completion at all', async () => {
    await mockPages([
      { Items: [eventItem, eventItem], LastEvaluatedKey: { k: 1 } },
      { Items: [completionItem(daysAgo(9))] },
    ]);
    await expect(readLastCompletion('hh')).resolves.toEqual({
      status: 'ok',
      completedAt: daysAgo(9),
    });
  });

  it('says "none" only when the partition was read to its end', async () => {
    await mockPages([{ Items: [eventItem] }]);
    await expect(readLastCompletion('hh')).resolves.toEqual({ status: 'none' });
  });

  it('says "unavailable" — never "none" — when the page budget runs out first', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // Every page is full of non-completions and always has a next key, so the
    // scan can never finish. Running out of budget is not evidence of absence.
    vi.mocked(dynamodb.send).mockResolvedValue({
      Items: [eventItem],
      LastEvaluatedKey: { k: 1 },
    } as never);

    const result = await readLastCompletion('hh');
    expect(result).toEqual({ status: 'unavailable', reason: 'completion_scan_incomplete' });
    // The cap is real: the scan stops rather than paging forever.
    expect(vi.mocked(dynamodb.send).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('says "unavailable" when the query throws', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValue(new Error('throttled'));
    await expect(readLastCompletion('hh')).resolves.toEqual({
      status: 'unavailable',
      reason: 'completions_read_failed',
    });
  });

  it('refuses an undated completion instead of falling through to an older row', async () => {
    await mockPages([{ Items: [completionItem(undefined), completionItem(daysAgo(200))] }]);
    // Reporting the 200-day-old row as the newest would be a stale date
    // published as a current one.
    await expect(readLastCompletion('hh')).resolves.toEqual({
      status: 'unavailable',
      reason: 'completion_timestamp_unreadable',
    });
  });
});

describe('householdLapse — the at-risk adapter', () => {
  const row = (over: Partial<AtRiskRow> = {}): AtRiskRow => ({
    plantId: 'p1',
    plantName: 'Monstera',
    taskId: 't1',
    taskType: 'water',
    customLabel: null,
    daysOverdue: 5,
    imageUrl: null,
    assignedTo: null,
    assignedToName: null,
    unclaimed: true,
    ...over,
  });

  it('passes an unreadable at-risk result straight through', () => {
    expect(overdueFromAtRisk({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
  });

  it('counts at-risk plants and takes the oldest readable overdue age', () => {
    const atRisk: AtRiskResult = {
      status: 'ok',
      rows: [row({ daysOverdue: 5 }), row({ plantId: 'p2', daysOverdue: 31 })],
      onTrack: 4,
      orphanTasks: 0,
    };
    expect(overdueFromAtRisk(atRisk)).toEqual({
      status: 'ok',
      atRiskPlants: 2,
      oldestOverdueDays: 31,
    });
  });

  it('reports an all-unreadable overdue age as null, never as 0 days', () => {
    const atRisk: AtRiskResult = {
      status: 'ok',
      rows: [row({ daysOverdue: null })],
      onTrack: 0,
      orphanTasks: 0,
    };
    // 0 describes a task that came due today. This is "we could not tell".
    expect(overdueFromAtRisk(atRisk)).toEqual({
      status: 'ok',
      atRiskPlants: 1,
      oldestOverdueDays: null,
    });
  });

  it('never lets a malformed overdue age reach Math.max as NaN', () => {
    const atRisk: AtRiskResult = {
      status: 'ok',
      // `undefined` is off-type, which is exactly when a `!== null` guard
      // would have published NaN as a number of days.
      rows: [row({ daysOverdue: undefined as unknown as number }), row({ plantId: 'p2' })],
      onTrack: 0,
      orphanTasks: 0,
    };
    expect(overdueFromAtRisk(atRisk)).toEqual({
      status: 'ok',
      atRiskPlants: 2,
      oldestOverdueDays: 5,
    });
  });

  it('counts plants, not tasks — gatherAtRisk keeps one row per plant', () => {
    const atRisk: AtRiskResult = {
      status: 'ok',
      rows: [row(), row({ plantId: 'p2' }), row({ plantId: 'p3' })],
      onTrack: 0,
      orphanTasks: 0,
    };
    expect(overdueFromAtRisk(atRisk)).toMatchObject({ atRiskPlants: 3 });
  });
});

describe('householdLapse — reading a whole household', () => {
  beforeEach(() => vi.clearAllMocks());

  it('costs one query when a completion exists — no household read', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    await mockPages([{ Items: [completionItem(daysAgo(30))] }]);

    await expect(readHouseholdEngagement('hh', someWork, NOW)).resolves.toEqual({
      status: 'lapsing',
      daysSinceLastCompletion: 30,
      atRiskPlants: 3,
      oldestOverdueDays: 40,
    });
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledOnce();
    const kinds = vi.mocked(dynamodb.send).mock.calls.map(([c]) => (c as { kind: string }).kind);
    expect(kinds).toEqual(['Query']);
  });

  it('reads the household age only on the never-started branch', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    let call = 0;
    vi.mocked(dynamodb.send).mockImplementation(async () => {
      call += 1;
      if (call === 1) return { Items: [] } as never;
      return { Item: { createdAt: daysAgo(3) } } as never;
    });

    await expect(readHouseholdEngagement('hh', someWork, NOW)).resolves.toEqual({
      status: 'never_active',
      householdAgeDays: 3,
      atRiskPlants: 3,
    });
    const kinds = vi.mocked(dynamodb.send).mock.calls.map(([c]) => (c as { kind: string }).kind);
    expect(kinds).toEqual(['Query', 'Get']);
  });

  it('survives a failed household-age read without inventing an age', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    let call = 0;
    vi.mocked(dynamodb.send).mockImplementation(async () => {
      call += 1;
      if (call === 1) return { Items: [] } as never;
      throw new Error('ddb hiccup');
    });

    await expect(readHouseholdEngagement('hh', someWork, NOW)).resolves.toEqual({
      status: 'never_active',
      householdAgeDays: null,
      atRiskPlants: 3,
    });
  });
});

describe('householdLapse — log fields', () => {
  it('omits every measurement it does not have', () => {
    expect(
      engagementLogFields({ status: 'unavailable', reason: 'completion_scan_incomplete' })
    ).toEqual({
      engagement: 'unavailable',
      engagementReason: 'completion_scan_incomplete',
    });
    // A CloudWatch filter reading $.daysSinceLastCompletion must not match a
    // household we never measured one for.
    expect(
      engagementLogFields({ status: 'never_active', householdAgeDays: null, atRiskPlants: 2 })
    ).toEqual({ engagement: 'never_active', atRiskPlants: 2 });
  });

  it('flattens a lapse into the numbers behind it', () => {
    expect(
      engagementLogFields({
        status: 'lapsing',
        daysSinceLastCompletion: 44,
        atRiskPlants: 6,
        oldestOverdueDays: 61,
      })
    ).toEqual({
      engagement: 'lapsing',
      daysSinceLastCompletion: 44,
      atRiskPlants: 6,
      oldestOverdueDays: 61,
    });
  });
});
