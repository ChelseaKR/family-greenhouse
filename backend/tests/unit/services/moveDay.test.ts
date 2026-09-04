import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Household,
  HouseholdMember,
  Plant,
  PlantSpace,
  Task,
} from '../../../src/models/types.js';
import type { WeatherSnapshot } from '../../../src/services/weather.js';
import type { MoveDayList } from '../../../src/services/moveDayPlan.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { kind: 'Put', input };
  }),
  QueryCommand: vi.fn(function (input) {
    return { kind: 'Query', input };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { kind: 'Update', input };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Thresholds and the signal rule stay REAL — the point of the feature is that
// it fires on exactly the night the climate tips would. Only the cache read
// is mocked.
vi.mock('../../../src/services/climate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/climate.js')>()),
  peekWeatherCached: vi.fn(),
}));
vi.mock('../../../src/services/weather.js', () => ({
  isConfigured: vi.fn(() => true),
  getWeatherDetailed: vi.fn(),
  geocodeDetailed: vi.fn(),
}));
vi.mock('../../../src/services/enrichment.js', () => ({ peekSpeciesCached: vi.fn() }));
vi.mock('../../../src/services/householdService.js', () => ({ getHouseholdMembers: vi.fn() }));
vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));
vi.mock('../../../src/services/spaceService.js', () => ({ getSpaces: vi.fn() }));
vi.mock('../../../src/services/taskService.js', () => ({
  getActiveVacationMap: vi.fn(),
  getTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
}));

const NOW = new Date('2026-10-14T20:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const household: Household = {
  id: 'hh-1',
  name: 'Home',
  location: { city: 'Portland', lat: 45.5, lon: -122.6 },
  createdAt: '',
  createdBy: 'u-a',
};

function space(over: Partial<PlantSpace> & Pick<PlantSpace, 'id' | 'name' | 'environment'>) {
  return {
    householdId: 'hh-1',
    rainExposure: 'sheltered',
    lightLevel: null,
    petAccess: null,
    defaultCaregiverId: null,
    createdAt: '',
    createdBy: 'u-a',
    updatedAt: '',
    ...over,
  } satisfies PlantSpace;
}
const patio = space({ id: 'patio', name: 'Patio', environment: 'outside' });
const living = space({ id: 'living', name: 'Living room', environment: 'inside' });
const kitchen = space({ id: 'kitchen', name: 'Kitchen', environment: 'inside' });

function plant(over: Partial<Plant> & Pick<Plant, 'id' | 'name'>): Plant {
  return {
    householdId: 'hh-1',
    species: null,
    location: null,
    spaceId: null,
    summerSpaceId: null,
    winterSpaceId: null,
    imageUrl: null,
    notes: null,
    status: 'active',
    tags: [],
    perenualSpeciesId: null,
    createdAt: '',
    createdBy: 'u-a',
    updatedAt: '',
    ...over,
  };
}
const monstera = plant({
  id: 'p-monstera',
  name: 'Monstera',
  spaceId: 'patio',
  summerSpaceId: 'patio',
  winterSpaceId: 'living',
});
const basil = plant({ id: 'p-basil', name: 'Basil', spaceId: 'patio', winterSpaceId: 'kitchen' });
const fern = plant({ id: 'p-fern', name: 'Fern', spaceId: 'living', winterSpaceId: 'living' });
// Outdoors, no winter home, species already cached: the hardiness hint's subject.
const cactus = plant({ id: 'p-cactus', name: 'Cactus', spaceId: 'patio', perenualSpeciesId: 7 });
const rose = plant({ id: 'p-rose', name: 'Rose', spaceId: 'patio', perenualSpeciesId: 8 });
const untyped = plant({ id: 'p-untyped', name: 'Mystery', spaceId: 'patio' });

function member(userId: string, name: string, joinedAt: string): HouseholdMember {
  return { householdId: 'hh-1', userId, name, email: `${userId}@x.test`, role: 'member', joinedAt };
}

const mild: WeatherSnapshot = {
  observedAt: NOW.toISOString(),
  tempC: 14,
  humidity: 50,
  condition: 'Clear',
  description: 'clear sky',
  forecast: [{ date: '2026-10-14', minC: 9, maxC: 16, humidity: 50 }],
};
const frosty: WeatherSnapshot = {
  ...mild,
  tempC: 8,
  forecast: [{ date: '2026-10-14', minC: 2, maxC: 11, humidity: 60 }],
};
const scorching: WeatherSnapshot = { ...mild, tempC: 34, forecast: [] };

function record(over: Partial<MoveDayList> & Pick<MoveDayList, 'season' | 'firedAt'>) {
  return {
    PK: 'HOUSEHOLD#hh-1',
    SK: `MOVEDAY#${over.season}`,
    signal: { tempC: 8, lowC: 2, frostLineC: 5, heatLineC: 32 },
    items: [],
    tenderWithoutWinterHome: [],
    ...over,
  };
}

type Sent = { kind: string; input: Record<string, unknown> };
function sent(): Sent[] {
  return vi
    .mocked((globalThis as unknown as { __ddb: { send: ReturnType<typeof vi.fn> } }).__ddb.send)
    .mock.calls.map((c) => c[0] as Sent);
}

async function setup(opts: {
  plants?: Plant[];
  spaces?: PlantSpace[];
  records?: ReturnType<typeof record>[];
  snapshot?: WeatherSnapshot | null;
  members?: HouseholdMember[];
  away?: string[];
  existingTasks?: Partial<Task>[];
  putFails?: boolean;
}) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  (globalThis as unknown as { __ddb: unknown }).__ddb = dynamodb;
  const climate = await import('../../../src/services/climate.js');
  const enrichment = await import('../../../src/services/enrichment.js');
  const householdService = await import('../../../src/services/householdService.js');
  const plantService = await import('../../../src/services/plantService.js');
  const spaceService = await import('../../../src/services/spaceService.js');
  const taskService = await import('../../../src/services/taskService.js');

  vi.mocked(plantService.getPlants).mockResolvedValue(opts.plants ?? [monstera, basil, fern]);
  vi.mocked(spaceService.getSpaces).mockResolvedValue(opts.spaces ?? [patio, living, kitchen]);
  vi.mocked(climate.peekWeatherCached).mockResolvedValue(
    opts.snapshot === undefined ? frosty : opts.snapshot
  );
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue(
    opts.members ?? [member('u-b', 'Ben', '2025-01-01'), member('u-a', 'Ada', '2024-01-01')]
  );
  vi.mocked(taskService.getActiveVacationMap).mockResolvedValue(
    new Map((opts.away ?? []).map((id) => [id, {} as never]))
  );
  vi.mocked(taskService.getTasks).mockResolvedValue((opts.existingTasks ?? []) as never);
  vi.mocked(taskService.createTask).mockImplementation(
    async (input, _hh, _uid, _name, options) =>
      ({
        id: `task-${input.plantId}`,
        assignedTo: options?.defaultAssigneeId ?? null,
        assignedToName:
          options?.defaultAssigneeId === 'u-a' ? 'Ada' : options?.defaultAssigneeId ? 'Ben' : null,
        assignmentSource: options?.defaultAssigneeId
          ? (options.defaultAssignmentSource ?? null)
          : null,
      }) as never
  );
  vi.mocked(taskService.updateTask).mockResolvedValue(null);
  vi.mocked(enrichment.peekSpeciesCached).mockImplementation(async (id) =>
    id === 7
      ? ({ hardinessZone: '10-12' } as never)
      : id === 8
        ? ({ hardinessZone: '5-9' } as never)
        : null
  );

  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { kind } = cmd as Sent;
    if (kind === 'Query') return { Items: opts.records ?? [] } as never;
    if (kind === 'Put') {
      if (opts.putFails) {
        const err = new Error('conditional') as Error & { name: string };
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      return {} as never;
    }
    return {} as never;
  });

  const { evaluateMoveDay } = await import('../../../src/services/moveDay.js');
  return { evaluateMoveDay, climate, taskService, enrichment, dynamodb };
}

describe('evaluateMoveDay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is silent (not_applicable) for a household with no outdoor space, without reading anything else', async () => {
    const { evaluateMoveDay, climate, dynamodb } = await setup({ spaces: [living, kitchen] });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({
      status: 'not_applicable',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(climate.peekWeatherCached).not.toHaveBeenCalled();
  });

  it('is silent (not_applicable) when no plant has a seasonal home', async () => {
    const { evaluateMoveDay } = await setup({ plants: [cactus, untyped] });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({
      status: 'not_applicable',
    });
  });

  it('serves a list fired in the last two weeks without touching the snapshot', async () => {
    const fired = record({ season: 'winter', firedAt: daysAgo(3), items: [] });
    const { evaluateMoveDay, climate, taskService } = await setup({ records: [fired] });
    const result = await evaluateMoveDay(household, 'u-a', NOW);
    expect(result.status).toBe('ready');
    expect(result.status === 'ready' && result.list.firedAt).toBe(fired.firedAt);
    expect(climate.peekWeatherCached).not.toHaveBeenCalled();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it('does nothing and says nothing (unavailable) without a saved location', async () => {
    const { evaluateMoveDay, climate } = await setup({});
    await expect(evaluateMoveDay({ ...household, location: null }, 'u-a', NOW)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(climate.peekWeatherCached).not.toHaveBeenCalled();
  });

  it('does nothing and says nothing (unavailable) when no snapshot is cached — never infers a frost', async () => {
    const { evaluateMoveDay, taskService, dynamodb } = await setup({ snapshot: null });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(sent().filter((c) => c.kind === 'Put')).toHaveLength(0);
    expect(dynamodb.send).toHaveBeenCalledTimes(1); // the records query only
  });

  it('is quiet on a mild night', async () => {
    const { evaluateMoveDay } = await setup({ snapshot: mild });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({ status: 'quiet' });
  });

  it('never re-fires the same season inside the re-fire window', async () => {
    const { evaluateMoveDay, taskService } = await setup({
      records: [record({ season: 'winter', firedAt: daysAgo(40) })],
    });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({ status: 'quiet' });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(sent().filter((c) => c.kind === 'Put')).toHaveLength(0);
  });

  it('does not ask everyone to carry it all back right after the other season fired', async () => {
    const { evaluateMoveDay } = await setup({
      snapshot: scorching,
      records: [record({ season: 'winter', firedAt: daysAgo(20) })],
    });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({ status: 'quiet' });
  });

  it('is quiet — and keeps the season unclaimed — when nothing is out of place', async () => {
    const { evaluateMoveDay } = await setup({ plants: [fern] });
    await expect(evaluateMoveDay(household, 'u-a', NOW)).resolves.toEqual({ status: 'quiet' });
    expect(sent().filter((c) => c.kind === 'Put')).toHaveLength(0);
  });

  it('fires on the first frost: claims the season, splits the moves round-robin, creates claimable tasks', async () => {
    const { evaluateMoveDay, taskService } = await setup({
      plants: [monstera, basil, fern, cactus, rose, untyped],
    });
    const result = await evaluateMoveDay(household, 'u-a', NOW);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    const { list } = result;

    expect(list.season).toBe('winter');
    expect(list.firedAt).toBe(NOW.toISOString());
    // The numbers are the snapshot's own, alongside the lines they crossed.
    expect(list.signal).toEqual({ tempC: 8, lowC: 2, frostLineC: 5, heatLineC: 32 });

    // Sorted by plant, split across members by join order (Ada before Ben),
    // the fern (already inside) and cactus/rose (no winter home) untouched.
    expect(list.items.map((i) => [i.plantName, i.toSpaceName, i.assigneeName, i.taskId])).toEqual([
      ['Basil', 'Kitchen', 'Ada', 'task-p-basil'],
      ['Monstera', 'Living room', 'Ben', 'task-p-monstera'],
    ]);

    // The season is claimed with a conditional put BEFORE any task is written.
    const put = sent().find((c) => c.kind === 'Put');
    expect(put?.input).toMatchObject({
      Item: { PK: 'HOUSEHOLD#hh-1', SK: 'MOVEDAY#winter', entityType: 'MoveDay', season: 'winter' },
      ConditionExpression: 'attribute_not_exists(SK) OR firedAt < :cutoff',
    });
    expect((put?.input.ExpressionAttributeValues as Record<string, string>)[':cutoff']).toBe(
      daysAgo(180)
    );

    // Through the existing task path, as yearly custom tasks whose assignee is
    // a suggestion other members can take over.
    expect(taskService.createTask).toHaveBeenCalledTimes(2);
    expect(taskService.createTask).toHaveBeenCalledWith(
      {
        plantId: 'p-basil',
        type: 'custom',
        customType: '→ Kitchen',
        frequency: 365,
        nextDue: NOW.toISOString(),
      },
      'hh-1',
      'u-a',
      'Basil',
      { defaultAssigneeId: 'u-a', defaultAssignmentSource: 'move_day' }
    );

    // The record is updated with the task ids once they exist.
    const update = sent().find((c) => c.kind === 'Update');
    expect(update?.input).toMatchObject({
      Key: { PK: 'HOUSEHOLD#hh-1', SK: 'MOVEDAY#winter' },
      ExpressionAttributeValues: { ':items': list.items },
    });

    // Hardiness hint: cached species only, presence-only. Cactus (zone 10+)
    // is named; rose (hardy) and the plant with no species are simply absent.
    expect(list.tenderWithoutWinterHome).toEqual([
      { plantId: 'p-cactus', plantName: 'Cactus', hardinessZone: '10-12' },
    ]);
  });

  it('skips members on vacation when splitting the work', async () => {
    const { evaluateMoveDay } = await setup({ away: ['u-a'] });
    const result = await evaluateMoveDay(household, 'u-a', NOW);
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.list.items.map((i) => i.assigneeName)).toEqual(['Ben', 'Ben']);
  });

  it('leaves the moves up for grabs when everyone is away', async () => {
    const { evaluateMoveDay, taskService } = await setup({ away: ['u-a', 'u-b'] });
    const result = await evaluateMoveDay(household, 'u-a', NOW);
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.list.items.every((i) => i.assigneeId === null)).toBe(true);
    expect(vi.mocked(taskService.createTask).mock.calls[0][4]).toEqual({
      defaultAssigneeId: undefined,
      defaultAssignmentSource: 'move_day',
    });
  });

  it("re-arms last year's move task instead of creating a duplicate", async () => {
    const { evaluateMoveDay, taskService } = await setup({
      plants: [monstera],
      existingTasks: [
        {
          id: 'task-old',
          plantId: 'p-monstera',
          type: 'custom',
          customType: '→ Living room',
          assignedTo: 'u-b',
          assignedToName: 'Ben',
        },
      ],
    });
    const result = await evaluateMoveDay(household, 'u-a', NOW);
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(taskService.updateTask).toHaveBeenCalledWith('hh-1', 'task-old', {
      nextDue: NOW.toISOString(),
    });
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(result.list.items[0]).toMatchObject({
      taskId: 'task-old',
      assigneeId: 'u-b',
      assigneeName: 'Ben',
    });
  });

  it('fires the reverse trip in summer, without the winter hardiness hint', async () => {
    const inside = { ...monstera, spaceId: 'living' };
    const { evaluateMoveDay, enrichment } = await setup({
      plants: [inside, basil, cactus],
      snapshot: scorching,
    });
    const result = await evaluateMoveDay(household, 'u-a', NOW);
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.list.season).toBe('summer');
    expect(result.list.items).toMatchObject([{ plantId: 'p-monstera', toSpaceId: 'patio' }]);
    expect(result.list.tenderWithoutWinterHome).toEqual([]);
    expect(enrichment.peekSpeciesCached).not.toHaveBeenCalled();
  });

  it('serves the concurrent winner’s list when it loses the claim race, creating nothing', async () => {
    const theirs = record({
      season: 'winter',
      firedAt: NOW.toISOString(),
      items: [{ plantId: 'p-basil' } as never],
    });
    const { evaluateMoveDay, taskService, dynamodb } = await setup({ putFails: true });
    // First query: no record yet; after the failed put, the winner's row.
    let queries = 0;
    vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
      const { kind } = cmd as Sent;
      if (kind === 'Query') return { Items: queries++ === 0 ? [] : [theirs] } as never;
      if (kind === 'Put') {
        const err = new Error('conditional') as Error & { name: string };
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      return {} as never;
    });

    const result = await evaluateMoveDay(household, 'u-a', NOW);
    expect(result).toMatchObject({ status: 'ready', list: { items: [{ plantId: 'p-basil' }] } });
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it('keeps the list when a task write fails, and says which task is missing', async () => {
    const { evaluateMoveDay, taskService } = await setup({ plants: [monstera, basil] });
    vi.mocked(taskService.createTask)
      .mockRejectedValueOnce(new Error('ddb throttled'))
      .mockResolvedValueOnce({
        id: 'task-p-monstera',
        assignedTo: 'u-b',
        assignedToName: 'Ben',
      } as never);
    const { logger } = await import('../../../src/utils/logger.js');

    const result = await evaluateMoveDay(household, 'u-a', NOW);
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.list.items.map((i) => i.taskId)).toEqual([null, 'task-p-monstera']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plantId: 'p-basil' }),
      'move_day.task_write_failed'
    );
  });

  it('aborts before claiming the season when the task scan fails — an unreadable list is not an empty one', async () => {
    const { evaluateMoveDay, taskService } = await setup({});
    vi.mocked(taskService.getTasks).mockRejectedValueOnce(new Error('ddb throttled'));

    await expect(evaluateMoveDay(household, 'u-a', NOW)).rejects.toThrow('ddb throttled');
    // Nothing written: no season claimed, so the next load retries cleanly
    // instead of duplicating every move task the household already has.
    expect(sent().filter((c) => c.kind === 'Put')).toHaveLength(0);
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });

  it('surfaces a failed records read as an error, not as calm', async () => {
    const { evaluateMoveDay, dynamodb } = await setup({});
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));
    await expect(evaluateMoveDay(household, 'u-a', NOW)).rejects.toThrow('ddb down');
  });
});
