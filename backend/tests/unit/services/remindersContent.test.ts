/**
 * What the daily reminder SAYS, end to end through `remindHousehold`.
 *
 * `reminders.test.ts` covers delivery: marker reservation, leases, channel
 * plans, DND deferral, vacation routing. This file covers the payload — the
 * part that used to be two integers and a link to a filtered list while the
 * full `Task[]` sat in scope on the line above it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';
import { deriveClimateTips } from '../../../src/services/climate.js';
import type { WeatherSnapshot } from '../../../src/services/weather.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
  getHousehold: vi.fn(async () => null),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasksDueBy: vi.fn(),
  getActiveVacationMap: vi.fn(async () => new Map()),
}));
vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));
vi.mock('../../../src/services/notificationPrefs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/notificationPrefs.js')>(
    '../../../src/services/notificationPrefs.js'
  );
  return { ...actual, getPreferences: vi.fn() };
});
vi.mock('../../../src/services/pestAlerts.js', () => ({
  evaluatePestAlerts: vi.fn(),
  wasAlerted: vi.fn(async () => false),
  markAlerted: vi.fn(),
}));
vi.mock('../../../src/services/climate.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/climate.js')>(
    '../../../src/services/climate.js'
  );
  return { ...actual, getWeatherCached: vi.fn() };
});
vi.mock('../../../src/services/notifier.js', () => ({
  sendToUser: vi.fn(async () => ({
    delivered: true,
    dndSuppressedOnly: false,
    channels: { browser: 'skipped', email: 'delivered', sms: 'skipped' },
  })),
}));

const NOW = new Date('2026-06-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const memberA = {
  householdId: 'hh',
  userId: 'u1',
  name: 'Ada',
  email: 'ada@x.com',
  role: 'admin' as const,
  joinedAt: '',
};
const memberB = {
  householdId: 'hh',
  userId: 'u2',
  name: 'Bo',
  email: 'bo@x.com',
  role: 'member' as const,
  joinedAt: '',
};

function prefsFor(userId: string, over: Partial<NotificationPreferences> = {}) {
  return {
    userId,
    browser: false,
    email: true,
    sms: false,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    pestAlerts: false,
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: '',
    ...over,
  } as NotificationPreferences;
}

/** Conditional-Put marker store: a second claim on the same key fails. */
async function mockMarkers() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const markers = new Map<string, Record<string, unknown>>();
  vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
    const { kind, input } = command as {
      kind: string;
      input: { Item?: Record<string, unknown>; Key?: Record<string, string> };
    };
    if (kind === 'Get') {
      const key = `${input.Key!.PK}|${input.Key!.SK}`;
      return { Item: markers.get(key) } as never;
    }
    if (kind !== 'Put') return {} as never;
    const item = input.Item!;
    const key = `${item.PK}|${item.SK}`;
    if (markers.has(key)) {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    markers.set(key, { ...item });
    return {} as never;
  });
}

async function setup(
  tasks: Array<Record<string, unknown>>,
  plants: Array<{ id: string; name: string }> = [{ id: 'p1', name: 'Monstera' }],
  members = [memberA]
) {
  const household = await import('../../../src/services/householdService.js');
  const taskService = await import('../../../src/services/taskService.js');
  const plantService = await import('../../../src/services/plantService.js');
  const prefs = await import('../../../src/services/notificationPrefs.js');
  await mockMarkers();
  vi.mocked(household.getHouseholdMembers).mockResolvedValue(members as never);
  vi.mocked(taskService.getTasksDueBy).mockResolvedValue(tasks as never);
  vi.mocked(plantService.getPlants).mockResolvedValue(plants as never);
  vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) => prefsFor(userId));
}

async function lastPayload() {
  const notifier = await import('../../../src/services/notifier.js');
  const calls = vi.mocked(notifier.sendToUser).mock.calls;
  return calls[calls.length - 1][1] as {
    title: string;
    body: string;
    shortBody?: string;
    url?: string;
  };
}

describe('reminder content', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names each plant and task and links every row to its own plant page', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(
      [
        {
          nextDue: iso(-6 * DAY),
          plantId: 'p1',
          assignedTo: 'u1',
          type: 'water',
          customType: null,
        },
        {
          nextDue: iso(-2 * DAY),
          plantId: 'p2',
          assignedTo: 'u1',
          type: 'fertilize',
          customType: null,
        },
      ],
      [
        { id: 'p1', name: 'Monstera' },
        { id: 'p2', name: 'Fiddle Leaf Fig' },
      ]
    );

    await remindHousehold('hh', NOW);
    const payload = await lastPayload();
    expect(payload.title).toBe('Plant care reminder: 2 overdue');
    expect(payload.body).toContain('1. Monstera — water, 6 days overdue');
    expect(payload.body).toContain('http://localhost:3000/plants/p1');
    expect(payload.body).toContain('2. Fiddle Leaf Fig — fertilize, 2 days overdue');
    expect(payload.body).toContain('http://localhost:3000/plants/p2');
    // The list link stays as the footer, not as every row's destination.
    expect(payload.url).toBe('http://localhost:3000/tasks?filter=due');
  });

  it('orders rows most urgent first', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(
      [
        { nextDue: iso(+2 * HOUR), plantId: 'p1', assignedTo: 'u1', type: 'water' },
        { nextDue: iso(-9 * DAY), plantId: 'p2', assignedTo: 'u1', type: 'water' },
        { nextDue: iso(-1 * HOUR), plantId: 'p3', assignedTo: 'u1', type: 'water' },
      ],
      [
        { id: 'p1', name: 'Soon' },
        { id: 'p2', name: 'Ancient' },
        { id: 'p3', name: 'Today' },
      ]
    );

    await remindHousehold('hh', NOW);
    const { body } = await lastPayload();
    expect(body).toContain('1. Ancient — water, 9 days overdue');
    expect(body).toContain('2. Today — water, due today');
    expect(body).toContain('3. Soon — water, due in the next 24 hours');
  });

  it('surfaces unassigned tasks as claimable in every member roll-up', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(
      [
        { nextDue: iso(-1 * DAY), plantId: 'p1', assignedTo: 'u1', type: 'water' },
        { nextDue: iso(-3 * DAY), plantId: 'p2', assignedTo: null, type: 'repot' },
      ],
      [
        { id: 'p1', name: 'Monstera' },
        { id: 'p2', name: 'Snake Plant' },
      ],
      [memberA, memberB]
    );

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(2);
    const notifier = await import('../../../src/services/notifier.js');
    for (const [, payload] of vi.mocked(notifier.sendToUser).mock.calls) {
      const body = (payload as { body: string }).body;
      expect(body).toContain('Up for grabs — nobody has claimed these, so anyone can:');
      expect(body).toContain('- Snake Plant — repot, 3 days overdue');
      expect(body).toContain('http://localhost:3000/plants/p2');
    }
    // The member who also owns a task sees both sections, correctly separated.
    const own = vi.mocked(notifier.sendToUser).mock.calls.find((c) => c[0].userId === 'u1')![1] as {
      title: string;
      body: string;
    };
    expect(own.title).toBe('Plant care reminder: 2 overdue, including 1 nobody has claimed');
    expect(own.body).toContain('1. Monstera — water, 1 day overdue');
  });

  it('never renders a failed member lookup as a person named "a housemate"', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const taskService = await import('../../../src/services/taskService.js');
    // u-ghost is away and covered by u1, but no roster row and no
    // denormalized name exist for them.
    vi.mocked(taskService.getActiveVacationMap).mockResolvedValueOnce(
      new Map([
        [
          'u-ghost',
          {
            householdId: 'hh',
            userId: 'u-ghost',
            coveredBy: 'u1',
            coveredByName: 'Ada',
            startDate: iso(-2 * DAY),
            endDate: iso(+4 * DAY),
            createdBy: 'u1',
            createdAt: '',
          },
        ],
      ]) as never
    );
    await setup([
      {
        nextDue: iso(-1 * DAY),
        plantId: 'p1',
        assignedTo: 'u-ghost',
        assignedToName: null,
        type: 'water',
      },
    ]);

    await remindHousehold('hh', NOW);
    const { body } = await lastPayload();
    expect(body).toContain("whose name we couldn't load");
    expect(body).not.toContain('a housemate');
  });

  it('tells the cover who is away and until when', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getActiveVacationMap).mockResolvedValueOnce(
      new Map([
        [
          'u2',
          {
            householdId: 'hh',
            userId: 'u2',
            coveredBy: 'u1',
            coveredByName: 'Ada',
            startDate: '2026-05-28T00:00:00.000Z',
            endDate: '2026-06-09T00:00:00.000Z',
            createdBy: 'u1',
            createdAt: '',
          },
        ],
      ]) as never
    );
    await setup(
      [
        {
          nextDue: iso(-1 * DAY),
          plantId: 'p1',
          assignedTo: 'u2',
          assignedToName: 'Bo',
          type: 'water',
        },
      ],
      [{ id: 'p1', name: 'Monstera' }],
      [memberA, memberB]
    );

    await remindHousehold('hh', NOW);
    const { body } = await lastPayload();
    // Not just "(covering for Bo)" — it says they are away, and until when.
    expect(body).toContain("You're covering for Bo, who is away until June 9, 2026.");
  });

  it('never emits a zero count in the summary', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(
      Array.from({ length: 5 }, (_, i) => ({
        nextDue: iso(-(i + 1) * DAY),
        plantId: 'p1',
        assignedTo: 'u1',
        type: 'water',
      }))
    );

    await remindHousehold('hh', NOW);
    const { title, body } = await lastPayload();
    // Was: "5 ready for some catch-up care, 0 coming up soon".
    expect(title).toBe('Plant care reminder: 5 overdue');
    expect(body).not.toMatch(/\b0\b/);
  });

  it('lists a capped subset but states the real total', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const count = 11;
    await setup(
      Array.from({ length: count }, (_, i) => ({
        nextDue: iso(-(i + 1) * DAY),
        plantId: `p${i}`,
        assignedTo: 'u1',
        type: 'water',
      })),
      Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Plant ${i}` }))
    );

    await remindHousehold('hh', NOW);
    const { title, body } = await lastPayload();
    expect(title).toBe(`Plant care reminder: ${count} overdue`);
    expect(body).toContain(`Showing 6 of ${count}.`);
  });

  it('sends a one-line shortBody so SMS and push do not get the whole list', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(
      Array.from({ length: 9 }, (_, i) => ({
        nextDue: iso(-(i + 1) * DAY),
        plantId: 'p1',
        assignedTo: 'u1',
        type: 'water',
      }))
    );

    await remindHousehold('hh', NOW);
    const { shortBody, body } = await lastPayload();
    expect(shortBody).toBe('9 overdue');
    expect(body.split('\n').length).toBeGreaterThan(5);
  });

  // #465. `reminderEmail` has carried a complete Spanish catalog the whole
  // time; `reminders.ts` pinned every send to a named `'en'` constant whose
  // docstring said no per-user language field existed. `emailLocale` does
  // exist, so the pin was sending English to people who had chosen Spanish —
  // and, because notifier.sendToUser fans this payload out, the push and SMS
  // bodies too.
  it('writes the whole payload in the recipient’s stored language', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    await setup([
      {
        nextDue: iso(-2 * DAY),
        plantId: 'p1',
        assignedTo: 'u1',
        type: 'water',
        customType: null,
      },
    ]);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      prefsFor(userId, { emailLocale: 'es' })
    );

    await remindHousehold('hh', NOW);

    const payload = await lastPayload();
    expect(payload.title).toContain('Recordatorio de cuidado de plantas');
    expect(payload.body).not.toContain('Plant care reminder');
    // The row itself, not just the subject: taskLabelFor takes the locale too.
    expect(payload.body).toMatch(/riego|regar|agua/i);
  });

  it('keeps English for a recipient who has never chosen a language', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    await setup([
      {
        nextDue: iso(-2 * DAY),
        plantId: 'p1',
        assignedTo: 'u1',
        type: 'water',
        customType: null,
      },
    ]);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      prefsFor(userId, { emailLocale: '' })
    );

    await remindHousehold('hh', NOW);

    expect((await lastPayload()).title).toContain('Plant care reminder');
  });
});

describe('reminder climate', () => {
  beforeEach(() => vi.clearAllMocks());

  const snapshot = (over: Partial<WeatherSnapshot> = {}): WeatherSnapshot => ({
    observedAt: NOW.toISOString(),
    tempC: 18,
    humidity: 55,
    condition: 'Clear',
    description: 'clear sky',
    forecast: [{ date: '2026-06-01', minC: 12, maxC: 22, humidity: 55 }],
    ...over,
  });

  async function withLocation(snap: WeatherSnapshot | null) {
    const household = await import('../../../src/services/householdService.js');
    const climate = await import('../../../src/services/climate.js');
    vi.mocked(household.getHousehold).mockResolvedValue({
      id: 'hh',
      name: 'Home',
      location: { city: 'Fullerton', lat: 33.87, lon: -117.92 },
      createdAt: '',
      createdBy: 'u1',
    } as never);
    vi.mocked(climate.getWeatherCached).mockResolvedValue(snap as never);
  }

  const dueTask = [{ nextDue: iso(-1 * DAY), plantId: 'p1', assignedTo: 'u1', type: 'water' }];

  it('adds the rain line on a rain day — the case the tip exists for', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(dueTask);
    await withLocation(snapshot({ condition: 'Rain' }));

    await remindHousehold('hh', NOW);
    const { body } = await lastPayload();
    expect(body).toContain(
      "Rain is forecast for your area — outdoor plants likely don't need watering today."
    );
  });

  it('adds the frost line from the forecast low', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(dueTask);
    await withLocation(
      snapshot({ forecast: [{ date: '2026-06-01', minC: 2.2, maxC: 9, humidity: 60 }] })
    );

    await remindHousehold('hh', NOW);
    const { body } = await lastPayload();
    expect(body).toContain('A low of 2°C is forecast tonight — bring tender plants indoors.');
  });

  it('says nothing about weather when the integration is not configured', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const climate = await import('../../../src/services/climate.js');
    await setup(dueTask);
    const household = await import('../../../src/services/householdService.js');
    vi.mocked(household.getHousehold).mockResolvedValue({
      id: 'hh',
      name: 'Home',
      location: { city: 'Fullerton', lat: 33.87, lon: -117.92 },
      createdAt: '',
      createdBy: 'u1',
    } as never);
    vi.mocked(climate.getWeatherCached).mockRejectedValue(
      new climate.ClimateUnavailableError('not_configured')
    );

    await remindHousehold('hh', NOW);
    const { body } = await lastPayload();
    // Absence is silence. "No rain expected" would be a claim we cannot make.
    expect(body).not.toMatch(/rain|forecast|indoors/i);
  });

  it('says nothing about weather when the household has no saved location', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(dueTask);
    const household = await import('../../../src/services/householdService.js');
    vi.mocked(household.getHousehold).mockResolvedValue({
      id: 'hh',
      name: 'Home',
      location: null,
      createdAt: '',
      createdBy: 'u1',
    } as never);

    await remindHousehold('hh', NOW);
    expect((await lastPayload()).body).not.toMatch(/rain|forecast/i);
    const climate = await import('../../../src/services/climate.js');
    expect(climate.getWeatherCached).not.toHaveBeenCalled();
  });

  it('reads the forecast at most once per household run', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup(
      [{ nextDue: iso(-1 * DAY), plantId: 'p1', assignedTo: null, type: 'water' }],
      [{ id: 'p1', name: 'Monstera' }],
      [memberA, memberB]
    );
    await withLocation(snapshot({ condition: 'Rain' }));

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(2);
    const climate = await import('../../../src/services/climate.js');
    expect(climate.getWeatherCached).toHaveBeenCalledTimes(1);
  });

  it('does not read the forecast at all when nothing is due', async () => {
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await setup([]);
    await withLocation(snapshot({ condition: 'Rain' }));

    await remindHousehold('hh', NOW);
    const climate = await import('../../../src/services/climate.js');
    expect(climate.getWeatherCached).not.toHaveBeenCalled();
  });

  it('the reminder rain/frost predicates agree with climate.deriveClimateTips', async () => {
    // The reminder derives its own two signals because deriveClimateTips
    // returns untranslatable English prose with no stable id. This test is the
    // guard that the two derivations cannot drift apart.
    const cases: WeatherSnapshot[] = [
      snapshot({ condition: 'Rain' }),
      snapshot({ condition: 'Thunderstorm' }),
      snapshot({ condition: 'Clear' }),
      snapshot({ forecast: [{ date: 'd', minC: 2, maxC: 9, humidity: 50 }] }),
      snapshot({ forecast: [{ date: 'd', minC: 5, maxC: 9, humidity: 50 }] }),
      snapshot({ forecast: [], tempC: 1 }),
    ];

    const { remindHousehold } = await import('../../../src/services/reminders.js');
    for (const snap of cases) {
      vi.clearAllMocks();
      await setup(dueTask);
      await withLocation(snap);
      await remindHousehold('hh', NOW);
      const { body } = await lastPayload();

      const tips = deriveClimateTips(snap);
      const tipsSayRain = tips.some((t) => t.message.includes('Rain expected'));
      const tipsSayFrost = tips.some((t) => t.message.includes('Bring tender plants indoors'));
      expect(body.includes('Rain is forecast')).toBe(tipsSayRain);
      expect(body.includes('bring tender plants indoors')).toBe(tipsSayFrost);
    }
  });
});
