import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/taskService.js', () => ({
  getTasksDueBy: vi.fn(),
  getTaskCompletions: vi.fn(),
  getDailyCompletionCounts: vi.fn(),
  getActiveVacationMap: vi.fn(),
}));
vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));
vi.mock('../../../src/services/spaceService.js', () => ({ getSpaces: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({ getHousehold: vi.fn() }));
vi.mock('../../../src/services/billing.js', () => ({ getHouseholdSubscription: vi.fn() }));
vi.mock('../../../src/services/doubleCare.js', () => ({ getScheduleDriftForPlant: vi.fn() }));
vi.mock('../../../src/services/climate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/climate.js')>();
  return { ...actual, peekCachedWeather: vi.fn() };
});

const taskService = await import('../../../src/services/taskService.js');
const plantService = await import('../../../src/services/plantService.js');
const spaceService = await import('../../../src/services/spaceService.js');
const householdService = await import('../../../src/services/householdService.js');
const billing = await import('../../../src/services/billing.js');
const doubleCare = await import('../../../src/services/doubleCare.js');
const climate = await import('../../../src/services/climate.js');
const report = await import('../../../src/services/digestReport.js');

const NOW = new Date('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const overdueBy = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const plant = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'p1',
  householdId: 'hh',
  name: 'Monstera',
  species: null,
  location: null,
  spaceId: null,
  imageUrl: null,
  notes: null,
  status: 'active',
  tags: [],
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  ...over,
});

const task = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 't1',
  householdId: 'hh',
  plantId: 'p1',
  plantName: 'Monstera',
  type: 'water',
  customType: null,
  frequency: 7,
  lastCompleted: null,
  nextDue: overdueBy(6),
  assignedTo: null,
  assignedToName: null,
  assignmentSource: null,
  notes: null,
  createdBy: '',
  createdAt: '',
  ...over,
});

const recipient = (over: Partial<report.DigestRecipient> = {}): report.DigestRecipient => ({
  userId: 'u1',
  name: 'Sam',
  locale: 'en',
  unsubscribeUrl: 'https://api.example/notifications/email/unsubscribe?t=tok',
  ...over,
});

function emptyReport(over: Partial<report.DigestReport> = {}): report.DigestReport {
  return {
    householdId: 'hh',
    householdName: 'The Kim House',
    atRisk: { status: 'ok', rows: [], onTrack: 0, orphanTasks: 0 },
    lastCare: new Map(),
    weather: { status: 'none' },
    trend: { status: 'ok', last7: 0, prev7: 0 },
    pets: { status: 'ok', warnings: [] },
    drift: { status: 'ok', finding: null },
    awayUserIds: new Set(),
    coverage: new Map(),
    ...over,
  };
}

const row = (over: Partial<report.AtRiskRow> = {}): report.AtRiskRow => ({
  plantId: 'p1',
  plantName: 'Monstera',
  taskId: 't1',
  taskType: 'water',
  customLabel: null,
  daysOverdue: 6,
  imageUrl: null,
  assignedTo: null,
  assignedToName: null,
  unclaimed: true,
  scheduledIntervalDays: 7,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://app.example';
  process.env.ASSETS_BASE_URL = 'https://app.example';
  process.env.PUBLIC_API_URL = 'https://api.example';
  vi.mocked(householdService.getHousehold).mockResolvedValue({ name: 'The Kim House' } as never);
  vi.mocked(taskService.getActiveVacationMap).mockResolvedValue(new Map() as never);
  vi.mocked(taskService.getTaskCompletions).mockResolvedValue([] as never);
  vi.mocked(taskService.getDailyCompletionCounts).mockResolvedValue([] as never);
  vi.mocked(spaceService.getSpaces).mockResolvedValue([] as never);
  vi.mocked(climate.peekCachedWeather).mockResolvedValue({ status: 'miss' } as never);
  // Free tier by default: the drift section is Garden-and-up, so every test
  // that does not opt in gets the `not_in_plan` state.
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' } as never);
  vi.mocked(doubleCare.getScheduleDriftForPlant).mockResolvedValue([] as never);
});

// ---------------------------------------------------------------------------
// Gathering — the honest-failure paths, one per data source
// ---------------------------------------------------------------------------

describe('gatherAtRisk', () => {
  it('ranks unclaimed work first, then by days overdue', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1', name: 'Monstera' }),
      plant({ id: 'p2', name: 'Pothos' }),
      plant({ id: 'p3', name: 'Fern' }),
    ] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([
      task({ id: 't1', plantId: 'p1', nextDue: overdueBy(9), assignedTo: 'u1' }),
      task({ id: 't2', plantId: 'p2', nextDue: overdueBy(2), assignedTo: null }),
      task({ id: 't3', plantId: 'p3', nextDue: overdueBy(5), assignedTo: 'u2' }),
    ] as never);

    const result = await report.gatherAtRisk('hh', NOW);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Nobody has taken Pothos, so it leads even though it is least overdue.
    expect(result.rows.map((r) => r.plantName)).toEqual(['Pothos', 'Monstera', 'Fern']);
    expect(result.onTrack).toBe(0);
  });

  it("carries the task's scheduled interval so drift needs no second read", async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([plant({ id: 'p1' })] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([
      task({ plantId: 'p1', frequency: 14 }),
    ] as never);
    const result = await report.gatherAtRisk('hh', NOW);
    expect(result.status === 'ok' && result.rows[0].scheduledIntervalDays).toBe(14);
  });

  it('counts on-track plants so the digest can lead with what is fine', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1' }),
      plant({ id: 'p2', name: 'Pothos' }),
      plant({ id: 'p3', name: 'Fern' }),
    ] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([task({ plantId: 'p1' })] as never);
    const result = await report.gatherAtRisk('hh', NOW);
    expect(result.status === 'ok' && result.onTrack).toBe(2);
  });

  it('reports a failed read as unavailable, NOT as an empty all-clear', async () => {
    vi.mocked(taskService.getTasksDueBy).mockRejectedValue(new Error('ddb down'));
    await expect(report.gatherAtRisk('hh', NOW)).resolves.toEqual({ status: 'unavailable' });
  });

  it('reports a failed plant read the same way', async () => {
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([task()] as never);
    vi.mocked(plantService.getPlants).mockRejectedValue(new Error('ddb down'));
    await expect(report.gatherAtRisk('hh', NOW)).resolves.toEqual({ status: 'unavailable' });
  });

  it('separates a task on a dead plant from a task whose plant does not exist', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1', status: 'died' }),
    ] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([
      task({ plantId: 'p1' }),
      task({ id: 't2', plantId: 'ghost' }),
    ] as never);
    const result = await report.gatherAtRisk('hh', NOW);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rows).toEqual([]);
    // The dead plant's task is a legitimate drop; the ghost's is an anomaly.
    expect(result.orphanTasks).toBe(1);
  });

  it('carries a null daysOverdue for an unreadable due date, never NaN', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([plant()] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([
      task({ nextDue: 'not-a-date' }),
    ] as never);
    const result = await report.gatherAtRisk('hh', NOW);
    expect(result.status === 'ok' && result.rows[0].daysOverdue).toBeNull();
  });
});

describe('gatherLastCare', () => {
  it('reports who last did the job and how long ago', async () => {
    vi.mocked(taskService.getTaskCompletions).mockResolvedValue([
      { completedBy: 'u2', completedByName: 'Sam', completedAt: overdueBy(11) },
    ] as never);
    const care = await report.gatherLastCare('hh', [row()], NOW);
    expect(care.get('p1')).toEqual({
      status: 'ok',
      byUserId: 'u2',
      byName: 'Sam',
      daysAgo: 11,
    });
  });

  it('distinguishes "never cared for" from "we could not read the history"', async () => {
    vi.mocked(taskService.getTaskCompletions).mockResolvedValue([] as never);
    expect((await report.gatherLastCare('hh', [row()], NOW)).get('p1')).toEqual({
      status: 'none',
    });

    vi.mocked(taskService.getTaskCompletions).mockRejectedValue(new Error('ddb down'));
    expect((await report.gatherLastCare('hh', [row()], NOW)).get('p1')).toEqual({
      status: 'unavailable',
    });
  });
});

describe('gatherWeather', () => {
  it('uses the cached snapshot and never calls the provider', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue({
      name: 'X',
      location: { lat: 1, lon: 2, city: 'Davis' },
    } as never);
    vi.mocked(climate.peekCachedWeather).mockResolvedValue({
      status: 'ok',
      snapshot: {
        observedAt: '',
        tempC: 20,
        humidity: 50,
        condition: 'Rain',
        description: 'rain',
        forecast: [],
      },
    } as never);
    const result = await report.gatherWeather('hh');
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.tips[0]).toMatch(/Rain expected/);
  });

  it('says nothing when there is no cached snapshot or no location', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue({ name: 'X' } as never);
    await expect(report.gatherWeather('hh')).resolves.toEqual({ status: 'none' });

    vi.mocked(householdService.getHousehold).mockResolvedValue({
      location: { lat: 1, lon: 2, city: 'Davis' },
    } as never);
    vi.mocked(climate.peekCachedWeather).mockResolvedValue({ status: 'miss' } as never);
    await expect(report.gatherWeather('hh')).resolves.toEqual({ status: 'none' });
  });

  it('distinguishes a cache-read failure from "nothing to report"', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue({
      location: { lat: 1, lon: 2, city: 'Davis' },
    } as never);
    vi.mocked(climate.peekCachedWeather).mockResolvedValue({ status: 'unavailable' } as never);
    await expect(report.gatherWeather('hh')).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('gatherTrend', () => {
  it('compares the last seven days with the seven before', async () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      date: `d${i}`,
      count: i >= 23 ? 2 : 1,
    }));
    vi.mocked(taskService.getDailyCompletionCounts).mockResolvedValue(series as never);
    await expect(report.gatherTrend('hh')).resolves.toEqual({
      status: 'ok',
      last7: 14,
      prev7: 7,
    });
  });

  it('reports a failed read as unavailable rather than a flat zero', async () => {
    vi.mocked(taskService.getDailyCompletionCounts).mockRejectedValue(new Error('ddb down'));
    await expect(report.gatherTrend('hh')).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('gatherPetWarnings', () => {
  it('warns only for a curated-table toxic plant in a pet-accessible space', async () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([
      { id: 's1', petAccess: true },
      { id: 's2', petAccess: false },
    ] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1', name: 'Monstera', spaceId: 's1' }),
      plant({ id: 'p2', name: 'Monstera', spaceId: 's2' }),
      plant({ id: 'p3', name: 'Spider plant', spaceId: 's1' }),
    ] as never);
    const result = await report.gatherPetWarnings('hh', [
      row({ plantId: 'p1' }),
      row({ plantId: 'p2' }),
      row({ plantId: 'p3' }),
    ]);
    expect(result).toEqual({
      status: 'ok',
      warnings: [{ plantId: 'p1', plantName: 'Monstera', pets: 'both' }],
    });
  });

  it('does not warn when pet access is unknown', async () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([{ id: 's1', petAccess: null }] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1', name: 'Monstera', spaceId: 's1' }),
    ] as never);
    await expect(report.gatherPetWarnings('hh', [row({ plantId: 'p1' })])).resolves.toEqual({
      status: 'ok',
      warnings: [],
    });
  });

  it('makes no toxicity claim for a plant the curated table does not cover', async () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([{ id: 's1', petAccess: true }] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1', name: 'Bob the mystery plant', spaceId: 's1' }),
    ] as never);
    await expect(report.gatherPetWarnings('hh', [row({ plantId: 'p1' })])).resolves.toEqual({
      status: 'ok',
      warnings: [],
    });
  });

  it('reports a failed spaces read rather than silently dropping the warning', async () => {
    // Omitting a pet-safety line because a query failed is an UNSAFE absence.
    vi.mocked(spaceService.getSpaces).mockRejectedValue(new Error('ddb down'));
    await expect(report.gatherPetWarnings('hh', [row()])).resolves.toEqual({
      status: 'unavailable',
    });
  });
});

// ---------------------------------------------------------------------------
// One plants query per report (#580)
// ---------------------------------------------------------------------------

describe('the household plants are queried once per report (#580)', () => {
  // `getPlants` issues the SAME DynamoDB Query for every filter value and
  // applies the filter in memory afterwards, so `gatherAtRisk`'s `'all'` read
  // and `gatherPetWarnings`' `'active'` read were the same partition twice.
  //
  // Every test here needs a NON-EMPTY at-risk list. `gatherPetWarnings`
  // returns early without reading anything when `rows` is empty, so a quiet
  // household would count one query either way and the assertions would pass
  // against the unfixed code.
  const petSafe = () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([{ id: 's1', petAccess: true }] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1', name: 'Monstera', spaceId: 's1' }),
    ] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([task({ plantId: 'p1' })] as never);
  };

  it('gatherAtRisk carries the active plants it has already read', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([
      plant({ id: 'p1' }),
      plant({ id: 'p2', name: 'Gone', status: 'died' }),
    ] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([task({ plantId: 'p1' })] as never);

    const result = await report.gatherAtRisk('hh', NOW);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // The ACTIVE subset — the exact rows `getPlants(id, 'active')` returns,
    // computed from the `'all'` rows already in hand. The dead plant is out.
    expect(result.activePlants?.map((p) => p.id)).toEqual(['p1']);
  });

  it('builds a whole report on ONE plants query, not two', async () => {
    petSafe();
    await report.gatherDigestReport('hh', NOW);
    // Two before this change: `gatherAtRisk` read `'all'` and
    // `gatherPetWarnings` read `'active'` off the same partition.
    expect(plantService.getPlants).toHaveBeenCalledTimes(1);
    expect(plantService.getPlants).toHaveBeenCalledWith('hh', 'all');
  });

  it('costs no plants query at all when the caller hands in the at-risk read', async () => {
    // #545's hoisted path: `digestHousehold` pays for `gatherAtRisk` as its
    // cheap gate, then hands the result down. The saving has to survive that
    // handoff or it merely moves — so the plants come along with the result.
    petSafe();
    const atRisk = await report.gatherAtRisk('hh', NOW);
    vi.mocked(plantService.getPlants).mockClear();

    await report.gatherDigestReport('hh', NOW, atRisk);
    expect(plantService.getPlants).not.toHaveBeenCalled();
  });

  it('still reads the plants when a precomputed result carries none', async () => {
    // `undefined` means "go and read", never "this household has no plants".
    // An AtRiskResult from anywhere but `gatherAtRisk` has nothing to give,
    // and assuming empty would silently drop every pet-safety line.
    petSafe();
    const atRisk = {
      status: 'ok' as const,
      rows: [row({ plantId: 'p1' })],
      onTrack: 0,
      orphanTasks: 0,
    };

    const built = await report.gatherDigestReport('hh', NOW, atRisk);
    expect(plantService.getPlants).toHaveBeenCalledTimes(1);
    expect(plantService.getPlants).toHaveBeenCalledWith('hh', 'active');
    expect(built.pets).toEqual({
      status: 'ok',
      warnings: [{ plantId: 'p1', plantName: 'Monstera', pets: 'both' }],
    });
  });

  it('reports a failed spaces read as unavailable even when the plants were handed in', async () => {
    // The branch this change is most likely to break, and it breaks SILENTLY:
    // skipping the plants read must not turn a failed SPACES read into a clean
    // empty warning list. That is the same unsafe absence ADR 0011 forbids,
    // just quieter.
    vi.mocked(spaceService.getSpaces).mockRejectedValue(new Error('ddb down'));
    const plants = [plant({ id: 'p1', spaceId: 's1' })];

    await expect(report.gatherPetWarnings('hh', [row()], plants as never)).resolves.toEqual({
      status: 'unavailable',
    });
    // And it got there without a read of its own — the spaces read is what
    // failed, and it is still issued.
    expect(plantService.getPlants).not.toHaveBeenCalled();
  });

  it('produces the same warnings from handed-in plants as from its own read', async () => {
    vi.mocked(spaceService.getSpaces).mockResolvedValue([{ id: 's1', petAccess: true }] as never);
    const plants = [plant({ id: 'p1', name: 'Monstera', spaceId: 's1' })];
    vi.mocked(plantService.getPlants).mockResolvedValue(plants as never);
    const rows = [row({ plantId: 'p1' })];

    const fromRead = await report.gatherPetWarnings('hh', rows);
    const fromHandoff = await report.gatherPetWarnings('hh', rows, plants as never);

    expect(fromHandoff).toEqual(fromRead);
    expect(fromHandoff).toEqual({
      status: 'ok',
      warnings: [{ plantId: 'p1', plantName: 'Monstera', pets: 'both' }],
    });
  });
});

describe('gatherScheduleDrift', () => {
  /** A `ScheduleDrift` payload with a reading over the threshold. */
  const drifted = (over: Record<string, unknown> = {}) => ({
    taskId: 't1',
    scheduledIntervalDays: 7,
    completionsConsidered: 6,
    requiredCompletions: 4,
    drift: {
      medianIntervalDays: 11.2,
      driftPct: 0.6,
      suggestedFrequency: 11,
      exceedsThreshold: true,
    },
    reason: null,
    ...over,
  });

  const garden = () =>
    vi
      .mocked(billing.getHouseholdSubscription)
      .mockResolvedValue({ planId: 'garden', status: 'active' } as never);

  it('never reads a history for a household without the toolkit', async () => {
    // Free tier: the drift suggestion is Garden-and-up, and a plan we DID read
    // is a reason not to look, not a failure to look.
    await expect(report.gatherScheduleDrift('hh', [row()])).resolves.toEqual({
      status: 'not_in_plan',
    });
    expect(doubleCare.getScheduleDriftForPlant).not.toHaveBeenCalled();
  });

  it('reads entitlement, not the plan row: a past_due Garden household is not in plan', async () => {
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'garden',
      status: 'past_due',
    } as never);
    await expect(report.gatherScheduleDrift('hh', [row()])).resolves.toEqual({
      status: 'not_in_plan',
    });
    expect(doubleCare.getScheduleDriftForPlant).not.toHaveBeenCalled();
  });

  it('says the plan could not be read rather than assuming either answer', async () => {
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValue(new Error('ddb down'));
    await expect(report.gatherScheduleDrift('hh', [row()])).resolves.toEqual({
      status: 'unavailable',
    });
    expect(doubleCare.getScheduleDriftForPlant).not.toHaveBeenCalled();
  });

  it('carries the strongest reading across the listed plants', async () => {
    garden();
    vi.mocked(doubleCare.getScheduleDriftForPlant)
      .mockResolvedValueOnce([drifted({ drift: { ...drifted().drift, driftPct: 0.4 } })] as never)
      .mockResolvedValueOnce([
        drifted({
          taskId: 't2',
          scheduledIntervalDays: 30,
          drift: { ...drifted().drift, driftPct: -0.7, suggestedFrequency: 9 },
        }),
      ] as never);

    await expect(
      report.gatherScheduleDrift('hh', [
        row(),
        row({
          plantId: 'p2',
          plantName: 'Fiddle Leaf',
          taskId: 't2',
          scheduledIntervalDays: 30,
        }),
      ])
    ).resolves.toEqual({
      status: 'ok',
      finding: {
        plantId: 'p2',
        plantName: 'Fiddle Leaf',
        taskId: 't2',
        taskType: 'water',
        customLabel: null,
        actualIntervalDays: 9,
        scheduledIntervalDays: 30,
      },
    });
  });

  it('finds nothing when no reading crosses the threshold', async () => {
    garden();
    vi.mocked(doubleCare.getScheduleDriftForPlant).mockResolvedValue([
      drifted({ drift: { ...drifted().drift, exceedsThreshold: false } }),
    ] as never);
    await expect(report.gatherScheduleDrift('hh', [row()])).resolves.toEqual({
      status: 'ok',
      finding: null,
    });
  });

  it('separates "not enough history yet" from "we could not read the history"', async () => {
    garden();
    // Too few completions: we looked, the answer is simply not knowable yet.
    vi.mocked(doubleCare.getScheduleDriftForPlant).mockResolvedValue([
      { ...drifted(), drift: null, reason: 'insufficient_completions' },
    ] as never);
    await expect(report.gatherScheduleDrift('hh', [row()])).resolves.toEqual({
      status: 'ok',
      finding: null,
    });

    // Every read failed: that is NOT "nothing drifted".
    vi.mocked(doubleCare.getScheduleDriftForPlant).mockResolvedValue([
      { ...drifted(), drift: null, reason: 'history_unavailable' },
    ] as never);
    await expect(report.gatherScheduleDrift('hh', [row()])).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('still reports a finding when only some of the histories could be read', async () => {
    garden();
    vi.mocked(doubleCare.getScheduleDriftForPlant)
      .mockResolvedValueOnce([
        { ...drifted(), drift: null, reason: 'history_unavailable' },
      ] as never)
      .mockResolvedValueOnce([drifted({ taskId: 't2' })] as never);
    const result = await report.gatherScheduleDrift('hh', [
      row(),
      row({ plantId: 'p2', taskId: 't2' }),
    ]);
    expect(result).toEqual({
      status: 'ok',
      finding: expect.objectContaining({ plantId: 'p2', actualIntervalDays: 11 }),
    });
  });

  it('costs nothing at all when the digest lists no plants', async () => {
    await expect(report.gatherScheduleDrift('hh', [])).resolves.toEqual({
      status: 'ok',
      finding: null,
    });
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
    expect(doubleCare.getScheduleDriftForPlant).not.toHaveBeenCalled();
  });

  it("asks for drift on the listed task using the row's own scheduled interval", async () => {
    garden();
    vi.mocked(doubleCare.getScheduleDriftForPlant).mockResolvedValue([drifted()] as never);
    await report.gatherScheduleDrift('hh', [row({ scheduledIntervalDays: 14 })]);
    expect(doubleCare.getScheduleDriftForPlant).toHaveBeenCalledWith('hh', 'p1', [
      { id: 't1', frequency: 14 },
    ]);
  });
});

describe('digestIsWorthSending', () => {
  it('sends when there is something to do', () => {
    expect(
      report.digestIsWorthSending(
        emptyReport({ atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 } })
      )
    ).toBe(true);
  });

  it('sends when a read failed, so silence is never mistaken for an all-clear', () => {
    expect(report.digestIsWorthSending(emptyReport({ atRisk: { status: 'unavailable' } }))).toBe(
      true
    );
    expect(report.digestIsWorthSending(emptyReport({ pets: { status: 'unavailable' } }))).toBe(
      true
    );
  });

  it('skips a genuinely quiet week rather than mailing a cheerful nothing', () => {
    expect(
      report.digestIsWorthSending(
        emptyReport({
          weather: { status: 'ok', tips: ['Rain expected'] },
          trend: { status: 'ok', last7: 9, prev7: 4 },
        })
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('composeDigestEmail', () => {
  it('states the TRUE at-risk total in the subject, not the number of rows listed', () => {
    const rows = Array.from({ length: 23 }, (_, i) =>
      row({ plantId: `p${i}`, plantName: `Plant ${i}`, daysOverdue: 23 - i, unclaimed: false })
    );
    const { subject, text } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'ok', rows, onTrack: 0, orphanTasks: 0 } }),
      recipient()
    );
    expect(subject).toBe('Weekly digest: 23 plants could use some care');
    // Five rows listed, and the body says how many more are waiting.
    expect(text).toContain('And 18 more plants are waiting.');
  });

  it('keeps subject and body agreeing for exactly one at-risk plant', () => {
    const { subject } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 } }),
      recipient()
    );
    expect(subject).toBe('Weekly digest: 1 plant could use some care');
  });

  it('never states a total it could not compute', () => {
    const { subject, text } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'unavailable' } }),
      recipient()
    );
    expect(subject).toBe('Weekly digest: your household check-in');
    expect(subject).not.toMatch(/\d/);
    expect(text).toContain('An empty list below means we did not manage to look');
  });

  it('leads with what is fine before what needs a hand', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: { status: 'ok', rows: [row()], onTrack: 11, orphanTasks: 0 },
      }),
      recipient()
    );
    const good = text.indexOf('11 of your plants are on track');
    const bad = text.indexOf('COULD USE A HAND');
    expect(good).toBeGreaterThan(-1);
    expect(bad).toBeGreaterThan(good);
  });

  it('deep-links every plant to that plant, never to the dashboard', () => {
    const { html, text } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 } }),
      recipient()
    );
    expect(html).toContain('https://app.example/plants/p1?task=t1');
    expect(text).toContain('https://app.example/plants/p1?task=t1');
  });

  it('escapes a plant name containing markup', () => {
    const { html, text } = report.composeDigestEmail(
      emptyReport({
        atRisk: {
          status: 'ok',
          rows: [row({ plantName: '<script>alert(1)</script>Ficus' })],
          onTrack: 0,
          orphanTasks: 0,
        },
      }),
      recipient()
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Ficus');
    expect(text).toContain('<script>alert(1)</script>Ficus');
  });

  it('names who last did the job, and says "you" to the person who did it', () => {
    const base = emptyReport({
      atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
      lastCare: new Map([
        ['p1', { status: 'ok', byUserId: 'u2', byName: 'Sam', daysAgo: 11 } as const],
      ]),
    });
    expect(report.composeDigestEmail(base, recipient({ userId: 'u1' })).text).toContain(
      'Last done by Sam 11 days ago.'
    );
    expect(report.composeDigestEmail(base, recipient({ userId: 'u2' })).text).toContain(
      'You did this one 11 days ago.'
    );
  });

  it('says the history could not be loaded rather than "never cared for"', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
        lastCare: new Map([['p1', { status: 'unavailable' } as const]]),
      }),
      recipient()
    );
    expect(text).toContain('Care history could not be loaded for this plant.');
    expect(text).not.toContain('No care logged');
  });

  it('routes a plant to the covering member, never to the member who is away', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: {
          status: 'ok',
          rows: [row({ unclaimed: false, assignedTo: 'u9', assignedToName: 'Sam' })],
          onTrack: 0,
          orphanTasks: 0,
        },
        coverage: new Map([['u9', { coverName: 'Alex', awayName: 'Sam' }]]),
      }),
      recipient()
    );
    expect(text).toContain('Alex is covering for Sam right now.');
    expect(text).not.toContain('Sam usually looks after this one.');
  });

  it('badges unclaimed work and puts it in the preheader', () => {
    const { html, text } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 } }),
      recipient()
    );
    expect(html).toContain('1 task is up for grabs.');
    expect(text).toContain('[Up for grabs] Monstera');
    expect(text).toContain('Nobody has claimed this yet.');
  });

  it('shows the most recent photo when it is on our own asset origin', () => {
    const { html } = report.composeDigestEmail(
      emptyReport({
        atRisk: {
          status: 'ok',
          rows: [row({ imageUrl: 'https://app.example/plants/hh/p1/a.jpg' })],
          onTrack: 0,
          orphanTasks: 0,
        },
      }),
      recipient()
    );
    expect(html).toContain('<img src="https://app.example/plants/hh/p1/a.jpg"');
  });

  it('carries one schedule-drift reading, with both intervals and a deep link', () => {
    const { text, html } = report.composeDigestEmail(
      emptyReport({
        atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
        drift: {
          status: 'ok',
          finding: {
            plantId: 'p1',
            plantName: 'Monstera',
            taskId: 't1',
            taskType: 'water',
            customLabel: null,
            actualIntervalDays: 11,
            scheduledIntervalDays: 7,
          },
        },
      }),
      recipient()
    );
    expect(text).toContain('A SCHEDULE WORTH A TWEAK'); // headings render upper-case in text
    expect(text).toContain(
      'Watering: this actually happens about every 11 days, but the schedule says every 7 days.'
    );
    expect(text).toContain('Open the plant to match its schedule to reality in one tap.');
    // The tap has to land where the one-tap action actually lives.
    expect(html).toContain('https://app.example/plants/p1?task=t1');
  });

  it('singularizes a one-day interval instead of saying "every 1 days"', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
        drift: {
          status: 'ok',
          finding: {
            plantId: 'p1',
            plantName: 'Monstera',
            taskId: 't1',
            taskType: 'water',
            customLabel: null,
            actualIntervalDays: 1,
            scheduledIntervalDays: 4,
          },
        },
      }),
      recipient()
    );
    expect(text).toContain('about every day, but the schedule says every 4 days');
  });

  it('names a custom task by its own label, never the word "custom"', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
        drift: {
          status: 'ok',
          finding: {
            plantId: 'p1',
            plantName: 'Monstera',
            taskId: 't1',
            taskType: 'custom',
            customLabel: 'Misting',
            actualIntervalDays: 11,
            scheduledIntervalDays: 7,
          },
        },
      }),
      recipient()
    );
    expect(text).toContain('Misting: this actually happens about every 11 days');
  });

  it('says nothing about drift in any state that is not a real finding', () => {
    // Positive end state first: the email still renders its at-risk row, so a
    // missing drift section is a real absence and not an unrendered email.
    for (const drift of [
      { status: 'ok', finding: null },
      { status: 'not_in_plan' },
      { status: 'unavailable' },
    ] as const) {
      const { text } = report.composeDigestEmail(
        emptyReport({
          atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
          drift,
        }),
        recipient()
      );
      expect(text).toContain('Monstera');
      expect(text).not.toContain('A SCHEDULE WORTH A TWEAK');
      expect(text).not.toContain('schedule says');
      // `unavailable` fires on a failed BILLING read, so at that point we do
      // not know the tier. A "we could not check your schedules" line would
      // advertise a paid feature to a free household off a failed read.
      expect(text).not.toContain('match its schedule');
    }
  });

  it('renders an honest line for each failed section', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
        weather: { status: 'unavailable' },
        trend: { status: 'unavailable' },
        pets: { status: 'unavailable' },
      }),
      recipient()
    );
    expect(text).toContain('! We could not read your local forecast this week.');
    expect(text).toContain('! We could not load your household’s 30-day trend.');
    expect(text).toContain('! We could not check which spaces your pets can reach.');
  });

  it('says nothing about a section that has nothing to say', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 } }),
      recipient()
    );
    expect(text).not.toContain('OUTSIDE THIS WEEK');
    expect(text).not.toContain('WORTH KNOWING');
    // Zero completions in both weeks is real data and uninformative; a line
    // about it would be guilt, not information.
    expect(text).not.toContain('in the last seven days');
  });

  it('renders a custom task with no label as "Custom care", never as "custom"', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: {
          status: 'ok',
          rows: [row({ taskType: 'custom', customLabel: null })],
          onTrack: 0,
          orphanTasks: 0,
        },
      }),
      recipient()
    );
    expect(text).toContain('Custom care · 6 days overdue');
    expect(text).not.toMatch(/(^|\s)custom · /);
  });

  it('says the due date is unreadable rather than rendering NaN days', () => {
    const { text } = report.composeDigestEmail(
      emptyReport({
        atRisk: {
          status: 'ok',
          rows: [row({ daysOverdue: null })],
          onTrack: 0,
          orphanTasks: 0,
        },
      }),
      recipient()
    );
    expect(text).toContain('we could not read this task’s due date');
    expect(text).not.toContain('NaN');
  });

  it('carries the one-click unsubscribe headers, and omits them when there is no URL', () => {
    const base = emptyReport({
      atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
    });
    const withUrl = report.composeDigestEmail(base, recipient());
    expect(withUrl.headers).toEqual({
      'List-Unsubscribe': '<https://api.example/notifications/email/unsubscribe?t=tok>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(withUrl.text).toContain('Unsubscribe from these: https://api.example');

    const without = report.composeDigestEmail(base, recipient({ unsubscribeUrl: null }));
    expect(without.headers).toBeUndefined();
    expect(without.text).not.toContain('Unsubscribe from these');
  });

  it('writes the whole digest in Spanish, with Spanish plural categories', () => {
    const rows = [row({ plantId: 'p1' }), row({ plantId: 'p2', plantName: 'Poto' })];
    const { subject, text, html } = report.composeDigestEmail(
      emptyReport({ atRisk: { status: 'ok', rows, onTrack: 4, orphanTasks: 0 } }),
      recipient({ locale: 'es' })
    );
    expect(subject).toBe('Resumen semanal: 2 plantas necesitan cuidados');
    expect(html).toContain('<html lang="es"');
    expect(text).toContain('Empecemos por lo bueno: 4 de tus plantas van al día.');
    expect(text).toContain('Riego · 6 días de retraso');
    expect(text).toContain('Todavía nadie la ha cogido.');
  });

  it('writes the drift reading in Spanish, singular and plural', () => {
    const finding = (over: Partial<report.DriftFinding> = {}): report.DriftFinding => ({
      plantId: 'p1',
      plantName: 'Monstera',
      taskId: 't1',
      taskType: 'water',
      customLabel: null,
      actualIntervalDays: 11,
      scheduledIntervalDays: 7,
      ...over,
    });
    const render = (f: report.DriftFinding) =>
      report.composeDigestEmail(
        emptyReport({
          atRisk: { status: 'ok', rows: [row()], onTrack: 0, orphanTasks: 0 },
          drift: { status: 'ok', finding: f },
        }),
        recipient({ locale: 'es' })
      ).text;

    expect(render(finding())).toContain(
      'Riego: en la práctica se hace cada 11 días, pero el calendario dice cada 7 días.'
    );
    // `_one` in Spanish, not the English `_other` leaking through.
    expect(render(finding({ actualIntervalDays: 1 }))).toContain(
      'se hace cada día, pero el calendario dice cada 7 días'
    );
    expect(render(finding())).toContain(
      'Abre la planta para ajustar su calendario a la realidad con un toque.'
    );
  });
});
