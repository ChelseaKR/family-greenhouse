import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

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
// Mocked so the run-summary line can be asserted: it is the only place the
// hourly scan's household/sent/failed counters exist outside the return value,
// and it is what the CloudWatch metric filters in
// infrastructure/modules/monitoring/main.tf read.
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
  // Read only by the reminder's climate lookup. No saved location by default,
  // so these tests never reach the weather provider.
  getHousehold: vi.fn(async () => null),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasksDueBy: vi.fn(),
  // Default: nobody is on vacation. Individual tests override with
  // mockResolvedValueOnce to exercise the redirection path.
  getActiveVacationMap: vi.fn(async () => new Map()),
}));
vi.mock('../../../src/services/plantService.js', () => ({
  getPlants: vi.fn(),
}));
vi.mock('../../../src/services/notificationPrefs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/notificationPrefs.js')>(
    '../../../src/services/notificationPrefs.js'
  );
  return {
    ...actual,
    getPreferences: vi.fn(),
  };
});
// Auto-handoff (ADR 0018) rides on the reminder scan; its own behaviour is
// covered in escalation.test.ts. Here it is a stub so these tests stay about
// reminders, plus one case pinning the hand-off contract below.
vi.mock('../../../src/services/escalation.js', () => ({
  runEscalations: vi.fn(async () => ({ escalated: 0, notified: 0 })),
}));
vi.mock('../../../src/services/pestAlerts.js', () => ({
  evaluatePestAlerts: vi.fn(),
  wasAlerted: vi.fn(async () => false),
  markAlerted: vi.fn(),
}));
vi.mock('../../../src/services/notifier.js', () => ({
  sendToUser: vi.fn(
    async (
      _recipient: unknown,
      _payload: unknown,
      options?: { channels?: Array<'browser' | 'email' | 'sms'> }
    ) => {
      const selected = options?.channels ?? ['email'];
      return {
        delivered: selected.length > 0,
        dndSuppressedOnly: false,
        channels: {
          browser: selected.includes('browser') ? 'delivered' : 'skipped',
          email: selected.includes('email') ? 'delivered' : 'skipped',
          sms: selected.includes('sms') ? 'delivered' : 'skipped',
        },
      };
    }
  ),
}));

const NOW = new Date('2026-06-01T12:00:00.000Z');
const soon = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(); // +1h
const past = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // -1h

const memberA = {
  householdId: 'hh',
  userId: 'u1',
  name: 'A',
  email: 'a@x.com',
  role: 'admin' as const,
  joinedAt: '',
};
const memberB = {
  householdId: 'hh',
  userId: 'u2',
  name: 'B',
  email: 'b@x.com',
  role: 'member' as const,
  joinedAt: '',
};

function notificationPreferences(
  userId: string,
  over: Partial<NotificationPreferences> = {}
): NotificationPreferences {
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
  };
}

async function mockActivePlants(ids: string[] = ['p1']) {
  const plants = await import('../../../src/services/plantService.js');
  // Names matter now: the reminder body lists each plant by name, so a
  // nameless fixture would exercise the "name could not be loaded" path.
  vi.mocked(plants.getPlants).mockResolvedValue(
    ids.map((id) => ({ id, name: `Plant ${id}` })) as never
  );
}

async function mockNoPestOptIns() {
  const prefs = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
    notificationPreferences(userId)
  );
}

/**
 * Simulates DynamoDB conditional puts: every marker PK|SK is remembered, and
 * a second conditional put on the same key throws ConditionalCheckFailed —
 * exactly the dedupe behavior the service relies on across hourly runs.
 */
async function mockConditionalMarkerStore() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const markers = new Map<string, Record<string, unknown>>();
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { input, kind } = cmd as {
      kind?: 'Put' | 'Get' | 'Delete' | 'Update';
      input: {
        Item?: { PK: string; SK: string; [key: string]: unknown };
        Key?: { PK: string; SK: string };
      };
    };
    // GetCommand → marker pre-check (alreadyRemindedToday). Return the marker
    // row when present so the read-side dedupe sees it.
    if (kind === 'Get' && input.Key) {
      const key = `${input.Key.PK}|${input.Key.SK}`;
      const item = markers.get(key);
      return (item ? { Item: item } : {}) as never;
    }
    // DeleteCommand → the pest-check marker cleanup when data was
    // unavailable, so a later hourly run can retry.
    if (kind === 'Delete' && input.Key) {
      const key = `${input.Key.PK}|${input.Key.SK}`;
      markers.delete(key);
      return {} as never;
    }
    // UpdateCommand finalizes a successful pre-send reservation. The marker
    // remains present, so later reads treat the day as delivered.
    if (kind === 'Update' && input.Key) {
      const key = `${input.Key.PK}|${input.Key.SK}`;
      const item = markers.get(key);
      if (item) markers.set(key, { ...item, status: 'sent' });
      return {} as never;
    }
    // PutCommand → conditional claim. Second claim on the same key throws
    // ConditionalCheckFailed, exactly the dedupe behavior across hourly runs.
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
  return markers;
}

describe('reminders service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('remindHousehold notifies only members with due/overdue tasks (one GSI1 query)', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    // u1 has one overdue + one due-soon; u2 has nothing (the far-future task
    // never comes back from the due-window query at all).
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1', type: 'water', customType: null },
      { nextDue: soon, plantId: 'p1', assignedTo: 'u1', type: 'prune', customType: null },
    ] as never);

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(1);
    expect(tasks.getTasksDueBy).toHaveBeenCalledOnce(); // one query per household
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
    const [recipient, payload] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect(recipient).toEqual({ userId: 'u1', email: 'a@x.com' });
    // The body names both tasks and links each to its own plant, instead of
    // reporting two integers against a filtered list.
    const body = (payload as { body: string }).body;
    expect(body).toContain('1 due today and 1 coming up');
    expect(body).toContain('Plant p1 — water, due today');
    expect(body).toContain('http://localhost:3000/plants/p1');
    expect(payload).toMatchObject({
      title: 'Plant care reminder: 1 due today and 1 coming up',
      tag: 'reminder-hh-2026-06-01',
      url: 'http://localhost:3000/tasks?filter=due',
    });
  });

  it('drops the email channel for a suppressed address, and reserves no lease for it', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    // Browser stays on so the member is still reachable; only email is dead.
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      notificationPreferences(userId, { browser: true, email: true })
    );
    // a@x.com hard-bounced. The row lives in the same simulated store the
    // markers do, so the real emailSuppression service reads it.
    markers.set('EMAIL#a@x.com|DELIVERY_STATE', {
      PK: 'EMAIL#a@x.com',
      SK: 'DELIVERY_STATE',
      email: 'a@x.com',
      state: 'suppressed',
      reason: 'hard_bounce',
      softBounceCount: 0,
      firstEventAt: '',
      lastEventAt: '',
    });
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    await remindHousehold('hh', NOW);

    const [, , options] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect((options as { channels: string[] }).channels).toEqual(['browser']);
    // No email lease was taken, so an address that will never work stops
    // churning a reserve/release pair through DynamoDB every hour.
    expect([...markers.keys()]).not.toContain(
      'USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email'
    );
  });

  it('keeps email eligible when the suppression lookup fails — unknown is not a verdict', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    const realSend = vi.mocked(dynamodb.send).getMockImplementation()!;
    vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
      const { kind, input } = cmd as { kind?: string; input: { Key?: { PK: string } } };
      if (kind === 'Get' && input.Key?.PK?.startsWith('EMAIL#')) {
        throw new Error('DynamoDB unavailable');
      }
      return realSend(cmd as never);
    });

    await remindHousehold('hh', NOW);

    const [, , options] = vi.mocked(notifier.sendToUser).mock.calls[0];
    // The send path re-checks and declines if it still cannot tell; that
    // releases the lease and the next hourly run retries. Dropping the channel
    // here would silence a working mailbox over a transient read failure.
    expect((options as { channels: string[] }).channels).toContain('email');
  });

  it('atomically reserves before delivery so overlapping runs send only once', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) => ({
      userId,
      browser: true,
      email: true,
      sms: true,
      phone: '+15551234567',
      dndStart: '',
      dndEnd: '',
      timezone: 'UTC',
      pestAlerts: false,
      weeklyDigest: true,
      phoneVerified: true,
      updatedAt: '',
    }));
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    let acceptDelivery!: () => void;
    vi.mocked(notifier.sendToUser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acceptDelivery = () =>
            resolve({
              delivered: true,
              dndSuppressedOnly: false,
              channels: {
                browser: 'delivered',
                email: 'delivered',
                sms: 'delivered',
              },
            });
        })
    );

    const first = remindHousehold('hh', NOW);
    // Let the first invocation reach the provider with its reservation held.
    await vi.waitFor(() => expect(notifier.sendToUser).toHaveBeenCalledOnce());
    const second = remindHousehold('hh', NOW);
    await vi.waitFor(() => expect(tasks.getTasksDueBy).toHaveBeenCalledTimes(2));
    acceptDelivery();

    expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
    expect(vi.mocked(notifier.sendToUser).mock.calls[0][2]).toMatchObject({
      channels: ['browser', 'email', 'sms'],
    });
  });

  it('uses the recipient local calendar date across a UTC midnight boundary', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      notificationPreferences(userId, { timezone: 'America/Los_Angeles' })
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    expect(await remindHousehold('hh', new Date('2026-06-01T23:30:00Z'))).toBe(1);
    expect(await remindHousehold('hh', new Date('2026-06-02T00:30:00Z'))).toBe(0);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
  });

  describe('when a reminder fires, relative to the due date (#343)', () => {
    // History. Until 2026-08-28 nothing pinned this: every `nextDue` fixture
    // in this file was `soon` (NOW + 1h) or `past` (NOW - 1h), both inside any
    // window and on the scan's own UTC day, so no boundary was ever crossed.
    // PR #682 then pinned the old behaviour as a characterization: a task due
    // Tue 22:00 in New York was announced Mon 22:00 (the rolling 24h window
    // opening), again Tue 00:00 (a fresh local-date slot), and then not at all
    // for the rest of Tuesday, the due instant included. That is #343.
    //
    // These replace those expectations deliberately. Each case fixes the
    // recipient's zone and a due instant, runs the real hourly scan tick by
    // tick across whole local days, and asserts the LOCAL day and time of
    // every send. `getTasksDueBy` honours its cutoff here, so the read horizon
    // is under test rather than mocked away.
    //
    // The rule, as the owner decided it on 2026-09-17: on the due day (never
    // before its local midnight), when the recipient's quiet hours end, or at
    // 08:00 local with none set; and every channel, push included, waits out
    // quiet hours. The scan runs at :05 past each UTC hour, so "08:00" is
    // observed as 08:05 (08:35 at a half-hour offset).

    const HOUR_MS = 60 * 60 * 1000;

    type DueFixture = { nextDue: string; plantId: string; assignedTo?: string | null };

    async function arrange(
      timeZoneFor: string | ((userId: string) => string),
      due: DueFixture[],
      over: Partial<NotificationPreferences> = {},
      members = [memberA]
    ) {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      await mockConditionalMarkerStore();
      await mockActivePlants([...new Set(due.map((d) => d.plantId))]);
      vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
        notificationPreferences(userId, {
          timezone: typeof timeZoneFor === 'string' ? timeZoneFor : timeZoneFor(userId),
          ...over,
        })
      );
      vi.mocked(household.getHouseholdMembers).mockResolvedValue(members as never);
      // GSI1 semantics: `GSI1SK <= cutoff`, no lower bound.
      vi.mocked(tasks.getTasksDueBy).mockImplementation(
        async (_householdId: string, cutoff: string) =>
          due
            .filter((d) => d.nextDue <= cutoff)
            .map((d) => ({
              assignedTo: 'u1',
              type: 'water',
              customType: null,
              ...d,
            })) as never
      );
      return await import('../../../src/services/reminders.js');
    }

    /** Wall clock in `timeZone`, as `YYYY-MM-DD HH:MM`. */
    function wallClock(at: Date, timeZone: string): string {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === type)?.value ?? '';
      return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
    }

    /**
     * Run the hourly scan `hours` times from `fromUtc`, and return each send
     * as `<recipient> <local wall clock>`. EventBridge's `rate(1 hour)` fires
     * at a fixed minute past each UTC hour; the fixtures use :05.
     */
    async function sendsOver(
      remindHousehold: (householdId: string, now: Date) => Promise<number>,
      fromUtc: string,
      hours: number,
      zoneOf: (userId: string) => string,
      { withChannels = false }: { withChannels?: boolean } = {}
    ): Promise<string[]> {
      const notifier = await import('../../../src/services/notifier.js');
      const fired: string[] = [];
      for (let h = 0; h < hours; h += 1) {
        const at = new Date(Date.parse(fromUtc) + h * HOUR_MS);
        const before = vi.mocked(notifier.sendToUser).mock.calls.length;
        await remindHousehold('hh', at);
        for (const [recipient, , options] of vi
          .mocked(notifier.sendToUser)
          .mock.calls.slice(before)) {
          const when = `${recipient.userId} ${wallClock(at, zoneOf(recipient.userId))}`;
          fired.push(withChannels ? `${when} ${(options?.channels ?? []).join('+')}` : when);
        }
      }
      return fired;
    }

    // Each case scans Mon 8 June 00:0x local through Wed 10 June 23:0x local
    // (72 hourly ticks) for ONE task due on Tuesday 9 June, local, for a
    // recipient with no quiet hours. The due instant sits on every side of UTC
    // midnight: the next UTC day, the same one, the previous one, and a
    // half-hour offset whose ticks land at :35.
    it.each([
      {
        name: 'New York, due 22:00 — the due instant is on the NEXT UTC day (the #343 fixture)',
        zone: 'America/New_York',
        from: '2026-06-08T04:05:00.000Z',
        nextDue: '2026-06-10T02:00:00.000Z',
        expected: ['u1 2026-06-09 08:05', 'u1 2026-06-10 08:05'],
      },
      {
        name: 'New York, due 09:00 — the same UTC day',
        zone: 'America/New_York',
        from: '2026-06-08T04:05:00.000Z',
        nextDue: '2026-06-09T13:00:00.000Z',
        expected: ['u1 2026-06-09 08:05', 'u1 2026-06-10 08:05'],
      },
      {
        name: 'Tokyo, due 08:00 — the due instant is on the PREVIOUS UTC day',
        zone: 'Asia/Tokyo',
        from: '2026-06-07T15:05:00.000Z',
        nextDue: '2026-06-08T23:00:00.000Z',
        expected: ['u1 2026-06-09 08:05', 'u1 2026-06-10 08:05'],
      },
      {
        name: 'Tokyo, due 20:00 — the same UTC day',
        zone: 'Asia/Tokyo',
        from: '2026-06-07T15:05:00.000Z',
        nextDue: '2026-06-09T11:00:00.000Z',
        expected: ['u1 2026-06-09 08:05', 'u1 2026-06-10 08:05'],
      },
      {
        name: 'Kolkata, due 03:00 — the previous UTC day, at a half-hour offset',
        zone: 'Asia/Kolkata',
        from: '2026-06-07T19:05:00.000Z',
        nextDue: '2026-06-08T21:30:00.000Z',
        expected: ['u1 2026-06-09 08:35', 'u1 2026-06-10 08:35'],
      },
      {
        name: 'UTC, due 23:30 — the last half hour of the UTC day',
        zone: 'UTC',
        from: '2026-06-08T00:05:00.000Z',
        nextDue: '2026-06-09T23:30:00.000Z',
        expected: ['u1 2026-06-09 08:05', 'u1 2026-06-10 08:05'],
      },
    ])(
      'reminds at 08:00 on the local due day, never the day before: $name',
      async ({ zone, from, nextDue, expected }) => {
        const { remindHousehold } = await arrange(zone, [{ nextDue, plantId: 'p1' }]);
        // Once on the due day, at 08:00; once more the next day at 08:00,
        // because it is then overdue. Nothing on Monday, nothing in the small
        // hours of Tuesday, and nothing else on Tuesday once the slot is spent.
        expect(await sendsOver(remindHousehold, from, 72, () => zone)).toEqual(expected);
      }
    );

    // Quiet hours that span midnight, in all four zones. Every channel is on,
    // so this is also push being held with the loud channels and released
    // with them. The due instant is on the far side of UTC midnight from the
    // due day in each zone that has one.
    it.each([
      {
        zone: 'America/New_York',
        from: '2026-06-08T04:05:00.000Z',
        nextDue: '2026-06-10T02:00:00.000Z',
        at: '07:05',
      },
      {
        zone: 'Asia/Tokyo',
        from: '2026-06-07T15:05:00.000Z',
        nextDue: '2026-06-08T23:00:00.000Z',
        at: '07:05',
      },
      {
        zone: 'Asia/Kolkata',
        from: '2026-06-07T19:05:00.000Z',
        nextDue: '2026-06-08T21:30:00.000Z',
        at: '07:35',
      },
      {
        zone: 'UTC',
        from: '2026-06-08T00:05:00.000Z',
        nextDue: '2026-06-09T23:30:00.000Z',
        at: '07:05',
      },
    ])(
      'with quiet hours 22:00→07:00 in $zone, every channel waits for them to end on the due day',
      async ({ zone, from, nextDue, at }) => {
        const { remindHousehold } = await arrange(zone, [{ nextDue, plantId: 'p1' }], {
          browser: true,
          sms: true,
          phone: '+15551234567',
          phoneVerified: true,
          dndStart: '22:00',
          dndEnd: '07:00',
        });
        expect(
          await sendsOver(remindHousehold, from, 72, () => zone, { withChannels: true })
        ).toEqual([
          `u1 2026-06-09 ${at} browser+email+sms`,
          `u1 2026-06-10 ${at} browser+email+sms`,
        ]);
      }
    );

    it('holds a browser-only push through quiet hours that cover midnight, then releases it', async () => {
      // The case #682 measured: browser push was exempt from quiet hours, and
      // the first run of the due day is ~00:05, so a browser-only recipient
      // with 22:00→07:00 was pushed at about midnight. Now nothing is even
      // attempted until the window ends.
      const zone = 'America/New_York';
      const notifier = await import('../../../src/services/notifier.js');
      const { logger } = await import('../../../src/utils/logger.js');
      const { remindHousehold } = await arrange(
        zone,
        [{ nextDue: '2026-06-09T13:00:00.000Z', plantId: 'p1' }],
        { browser: true, email: false, dndStart: '22:00', dndEnd: '07:00' }
      );
      // Tue 00:05 → 06:05 EDT: held, and no provider call at all.
      expect(await sendsOver(remindHousehold, '2026-06-09T04:05:00.000Z', 7, () => zone)).toEqual(
        []
      );
      expect(notifier.sendToUser).not.toHaveBeenCalled();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ deliverAt: '07:00' }),
        'reminders.held_until_delivery_time'
      );
      // 07:05 EDT: released, on the push channel.
      expect(
        await sendsOver(remindHousehold, '2026-06-09T11:05:00.000Z', 1, () => zone, {
          withChannels: true,
        })
      ).toEqual(['u1 2026-06-09 07:05 browser']);
    });

    it('holds push through quiet hours that have started again after the delivery time', async () => {
      // The first run that finds this task is 23:05 on its due day — after
      // 07:00, but back inside 22:00→07:00. Push is deferred there exactly as
      // email and SMS are, and goes out when the window ends the next morning.
      const zone = 'America/New_York';
      const { logger } = await import('../../../src/utils/logger.js');
      const { remindHousehold } = await arrange(
        zone,
        [{ nextDue: '2026-06-09T13:00:00.000Z', plantId: 'p1' }],
        { browser: true, email: false, dndStart: '22:00', dndEnd: '07:00' }
      );
      expect(
        await sendsOver(remindHousehold, '2026-06-10T03:05:00.000Z', 10, () => zone, {
          withChannels: true,
        })
      ).toEqual(['u1 2026-06-10 07:05 browser']);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ['browser'] }),
        'reminders.dnd_deferred_retry_next_run'
      );
    });

    it('delivers when a daytime quiet window ends, not before it', async () => {
      // The rule applied literally: quiet hours 13:00→15:00 make 15:00 the
      // delivery time, although the morning is outside the window.
      const zone = 'Asia/Tokyo';
      const { remindHousehold } = await arrange(
        zone,
        [{ nextDue: '2026-06-08T23:00:00.000Z', plantId: 'p1' }],
        { dndStart: '13:00', dndEnd: '15:00' }
      );
      expect(await sendsOver(remindHousehold, '2026-06-08T15:05:00.000Z', 24, () => zone)).toEqual([
        'u1 2026-06-09 15:05',
      ]);
    });

    it('delivers at the first run of the day when quiet hours end at midnight', async () => {
      const zone = 'UTC';
      const { remindHousehold } = await arrange(
        zone,
        [{ nextDue: '2026-06-09T12:00:00.000Z', plantId: 'p1' }],
        { dndStart: '22:00', dndEnd: '00:00' }
      );
      expect(await sendsOver(remindHousehold, '2026-06-08T00:05:00.000Z', 48, () => zone)).toEqual([
        'u1 2026-06-09 00:05',
      ]);
    });

    it.each([
      {
        name: 'spring forward (New York, 14 March 2027)',
        from: '2027-03-13T05:05:00.000Z',
        nextDue: '2027-03-14T16:00:00.000Z',
        expected: ['u1 2027-03-14 08:05', 'u1 2027-03-15 08:05'],
        // 08:05 EDT on the DST day, 08:05 EST on the day before.
        firstSendUtc: '2027-03-14T12:05:00.000Z',
      },
      {
        name: 'fall back (New York, 1 November 2026)',
        from: '2026-10-31T04:05:00.000Z',
        nextDue: '2026-11-01T17:00:00.000Z',
        expected: ['u1 2026-11-01 08:05', 'u1 2026-11-02 08:05'],
        firstSendUtc: '2026-11-01T13:05:00.000Z',
      },
    ])('keeps 08:00 on the wall clock across a DST change: $name', async (c) => {
      const zone = 'America/New_York';
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await arrange(zone, [{ nextDue: c.nextDue, plantId: 'p1' }]);
      expect(await sendsOver(remindHousehold, c.from, 72, () => zone)).toEqual(c.expected);
      const [, , firstOptions] = vi.mocked(notifier.sendToUser).mock.calls[0];
      expect((firstOptions as { now: Date }).now.toISOString()).toBe(c.firstSendUtc);
    });

    it('reaches a quiet-hours end the spring-forward skips at the first run after the jump', async () => {
      // 14 March 2027 in New York has no 02:30. Quiet hours 23:00→02:30 end at
      // the first run after 02:00 EST becomes 03:00 EDT.
      const zone = 'America/New_York';
      const { remindHousehold } = await arrange(
        zone,
        [{ nextDue: '2027-03-14T16:00:00.000Z', plantId: 'p1' }],
        { dndStart: '23:00', dndEnd: '02:30' }
      );
      expect(await sendsOver(remindHousehold, '2027-03-14T05:05:00.000Z', 23, () => zone)).toEqual([
        'u1 2027-03-14 03:05',
      ]);
    });

    it('reminds each member on their OWN local due day and hour from one household read', async () => {
      // One unassigned task due Tue 9 June 13:00Z: 09:00 Tuesday in New York,
      // 22:00 Tuesday in Tokyo. Each is told at 08:00 on their own Tuesday,
      // 13 hours apart in absolute time.
      const zones: Record<string, string> = { u1: 'America/New_York', u2: 'Asia/Tokyo' };
      const zoneOf = (userId: string) => zones[userId];
      const { remindHousehold } = await arrange(
        zoneOf,
        [{ nextDue: '2026-06-09T13:00:00.000Z', plantId: 'p1', assignedTo: null }],
        {},
        [memberA, memberB]
      );
      // Tokyo's Monday 00:05 through New York's Wednesday 00:05.
      const fired = await sendsOver(remindHousehold, '2026-06-07T15:05:00.000Z', 61, zoneOf);
      expect(fired).toEqual(['u2 2026-06-09 08:05', 'u1 2026-06-09 08:05', 'u2 2026-06-10 08:05']);
    });

    it('names a task due late on a 25-hour fall-back day in that day’s first reminder', async () => {
      // Sun 1 Nov 2026, New York falls back at 02:00. With quiet hours ending
      // at midnight the day's first run, 00:05 EDT, is its delivery time, and
      // the day ends 24h55m later. A 24-hour read would miss the task due
      // 23:30 EST, and with the slot spent on the 08:00 task it would not be
      // named until the next day, as overdue.
      const zone = 'America/New_York';
      const firstTick = '2026-11-01T04:05:00.000Z';
      const late = '2026-11-02T04:30:00.000Z';
      // The fixture is only worth having if it really sits past 24 hours.
      expect(Date.parse(late) - Date.parse(firstTick)).toBeGreaterThan(24 * HOUR_MS);
      expect(wallClock(new Date(late), zone)).toBe('2026-11-01 23:30');

      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await arrange(
        zone,
        [
          { nextDue: '2026-11-01T13:00:00.000Z', plantId: 'p1' },
          { nextDue: late, plantId: 'p2' },
        ],
        { dndStart: '22:00', dndEnd: '00:00' }
      );
      expect(await remindHousehold('hh', new Date(firstTick))).toBe(1);
      const body = (vi.mocked(notifier.sendToUser).mock.calls[0][1] as { body: string }).body;
      expect(body).toContain('Plant p1');
      expect(body).toContain('Plant p2');
    });

    it('a UTC-defaulted recipient gets UTC days and a UTC 08:00 (#342)', async () => {
      // The limit this does not remove. `prefs.timezone` reads 'UTC' for
      // anyone who never had a zone saved (`notificationPrefs.ts` has no
      // "never chosen" state for it), so for a New Yorker on the default both
      // the reminder's day and its 08:00 are UTC's: 04:05 in New York. A task
      // due Tuesday morning there is reminded early Tuesday; one due Tuesday
      // 22:00 falls on UTC Wednesday and is reminded at 04:05 Wednesday,
      // after it was due. Knowing their zone is what fixes this.
      const home = 'America/New_York';
      const { remindHousehold } = await arrange('UTC', [
        { nextDue: '2026-06-09T13:00:00.000Z', plantId: 'p1' },
      ]);
      expect(await sendsOver(remindHousehold, '2026-06-08T04:05:00.000Z', 48, () => home)).toEqual([
        'u1 2026-06-09 04:05',
      ]);

      vi.clearAllMocks();
      const late = await arrange('UTC', [{ nextDue: '2026-06-10T02:00:00.000Z', plantId: 'p1' }]);
      expect(
        await sendsOver(late.remindHousehold, '2026-06-08T04:05:00.000Z', 72, () => home)
      ).toEqual(['u1 2026-06-10 04:05']);
    });
  });

  describe('isDueByEndOfLocalDay', () => {
    const NY = 'America/New_York';
    // Tue 9 June 2026, 00:05 EDT.
    const tuesdayMorningNY = new Date('2026-06-09T04:05:00.000Z');

    it.each([
      ['later today, past UTC midnight', '2026-06-10T02:00:00.000Z', true],
      ['later today, same UTC day', '2026-06-09T13:00:00.000Z', true],
      ['already passed today', '2026-06-09T04:00:00.000Z', true],
      ['yesterday', '2026-06-08T20:00:00.000Z', true],
      ['the last minute of today', '2026-06-10T03:59:00.000Z', true],
      ['tomorrow, though well inside 24 hours', '2026-06-10T04:01:00.000Z', false],
    ])('%s → %s', async (_name, nextDue, expected) => {
      const { isDueByEndOfLocalDay } = await import('../../../src/services/reminders.js');
      expect(isDueByEndOfLocalDay(nextDue, tuesdayMorningNY, NY)).toBe(expected);
    });

    it('keeps a due date it cannot read, and keeps everything on a broken clock', async () => {
      const { isDueByEndOfLocalDay } = await import('../../../src/services/reminders.js');
      expect(isDueByEndOfLocalDay('not-a-date', tuesdayMorningNY, NY)).toBe(true);
      expect(isDueByEndOfLocalDay(null, tuesdayMorningNY, NY)).toBe(true);
      expect(isDueByEndOfLocalDay(undefined, tuesdayMorningNY, NY)).toBe(true);
      expect(isDueByEndOfLocalDay('2030-01-01T00:00:00.000Z', new Date(Number.NaN), NY)).toBe(true);
    });
  });

  describe('reminderDeliveryTime', () => {
    it.each([
      ['no quiet hours → 08:00', '', '', '08:00'],
      ['quiet hours over midnight → when they end', '22:00', '07:00', '07:00'],
      ['a daytime window → when it ends', '13:00', '15:00', '15:00'],
      ['ending at midnight → 00:00', '22:00', '00:00', '00:00'],
      ['start equal to end suppresses nothing → 08:00', '07:00', '07:00', '08:00'],
      ['only an end → 08:00', '', '06:00', '08:00'],
      ['an end that does not parse → 08:00, not midnight', '22:00', '7am', '08:00'],
      ['an out-of-range end → 08:00', '22:00', '24:30', '08:00'],
    ])('%s', async (_name, dndStart, dndEnd, expected) => {
      const { reminderDeliveryTime, REMINDER_DEFAULT_DELIVERY_TIME } =
        await import('../../../src/services/reminders.js');
      expect(REMINDER_DEFAULT_DELIVERY_TIME).toBe('08:00');
      expect(reminderDeliveryTime(notificationPreferences('u1', { dndStart, dndEnd }))).toBe(
        expected
      );
    });

    it('is compared on the recipient’s wall clock, and 08:00 itself is not before 08:00', async () => {
      const { isBeforeReminderDeliveryTime } = await import('../../../src/services/reminders.js');
      const ny = notificationPreferences('u1', { timezone: 'America/New_York' });
      expect(isBeforeReminderDeliveryTime(ny, new Date('2026-06-09T11:59:00.000Z'))).toBe(true); // 07:59
      expect(isBeforeReminderDeliveryTime(ny, new Date('2026-06-09T12:00:00.000Z'))).toBe(false); // 08:00
      // An empty zone reads as UTC, as everywhere else in the reminder path.
      const blank = notificationPreferences('u1', { timezone: '' });
      expect(isBeforeReminderDeliveryTime(blank, new Date('2026-06-09T07:59:00.000Z'))).toBe(true);
      expect(isBeforeReminderDeliveryTime(blank, new Date('2026-06-09T08:00:00.000Z'))).toBe(false);
      // Local midnight is minute 0, never 24:00.
      const utcMidnight = notificationPreferences('u1', { dndStart: '22:00', dndEnd: '00:00' });
      expect(isBeforeReminderDeliveryTime(utcMidnight, new Date('2026-06-09T00:00:00.000Z'))).toBe(
        false
      );
    });
  });

  it('includes unassigned due tasks in every member roll-up', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: soon, plantId: 'p1', assignedTo: null }, // unassigned
      { nextDue: soon, plantId: 'p1', assignedTo: 'u-gone' }, // assignee left household
    ] as never);

    const sent = await remindHousehold('hh', NOW);
    // Both members get the roll-up — previously unassigned tasks notified nobody.
    expect(sent).toBe(2);
    const recipients = vi.mocked(notifier.sendToUser).mock.calls.map((c) => c[0].userId);
    expect(recipients.sort()).toEqual(['u1', 'u2']);
    // Both rows are unassigned, so they are surfaced as claimable rather than
    // rolled into an anonymous integer that every member reads as somebody
    // else's problem.
    const rollup = vi.mocked(notifier.sendToUser).mock.calls[0][1] as {
      body: string;
      shortBody: string;
    };
    expect(rollup.body).toContain('2 coming up, including 2 nobody has claimed');
    expect(rollup.body).toContain('Up for grabs');
    expect(rollup.shortBody).toBe('2 coming up, including 2 nobody has claimed');
  });

  it('dedupes across consecutive runs: second run the same day sends nothing', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    // Hour 1: reminder goes out and the marker is written.
    expect(await remindHousehold('hh', NOW)).toBe(1);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email')).toBe(true);

    // Hour 2 (same task still due): marker present → no second send.
    const hourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await remindHousehold('hh', hourLater)).toBe(0);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();

    // Next day: fresh marker key → reminder goes out again.
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await remindHousehold('hh', nextDay)).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledTimes(2);
  });

  it('does not let one household suppress the same user’s other household reminder', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.getHouseholdMembers).mockImplementation(async (householdId: string) => [
      { ...memberA, householdId },
    ]);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    expect(await remindHousehold('home', NOW)).toBe(1);
    expect(await remindHousehold('cabin', NOW)).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledTimes(2);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#home#CHANNEL#email')).toBe(true);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#cabin#CHANNEL#email')).toBe(true);
  });

  it('does not reserve a DND-deferred email, so it sends once quiet hours end', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) => ({
      userId,
      browser: false,
      email: true,
      sms: false,
      phone: '',
      dndStart: '11:00',
      dndEnd: '13:00',
      timezone: 'UTC',
      pestAlerts: false,
      weeklyDigest: true,
      phoneVerified: false,
      updatedAt: '',
    }));

    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    // 12:00: email is inside DND, so it gets no marker and no provider call.
    expect(await remindHousehold('hh', NOW)).toBe(0);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email')).toBe(false);
    expect(notifier.sendToUser).not.toHaveBeenCalled();

    // 13:00 is the half-open DND end: email sends and gets its own marker.
    const hourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await remindHousehold('hh', hourLater)).toBe(1);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email')).toBe(true);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
  });

  it('keeps successful channel markers while retrying only a failed sibling', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      notificationPreferences(userId, {
        email: true,
        sms: true,
        phone: '+15551234567',
        phoneVerified: true,
      })
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);
    vi.mocked(notifier.sendToUser)
      .mockResolvedValueOnce({
        delivered: true,
        dndSuppressedOnly: false,
        channels: {
          browser: 'skipped',
          email: 'delivered',
          sms: 'failed',
        },
      })
      .mockResolvedValueOnce({
        delivered: true,
        dndSuppressedOnly: false,
        channels: {
          browser: 'skipped',
          email: 'skipped',
          sms: 'delivered',
        },
      });

    expect(await remindHousehold('hh', NOW)).toBe(1);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email')).toBe(true);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#sms')).toBe(false);

    const hourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await remindHousehold('hh', hourLater)).toBe(1);
    expect(vi.mocked(notifier.sendToUser).mock.calls[0][2]).toMatchObject({
      channels: ['email', 'sms'],
    });
    expect(vi.mocked(notifier.sendToUser).mock.calls[1][2]).toMatchObject({
      channels: ['sms'],
    });
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email')).toBe(true);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#sms')).toBe(true);

    expect(await remindHousehold('hh', new Date(NOW.getTime() + 2 * 60 * 60 * 1000))).toBe(0);
    expect(notifier.sendToUser).toHaveBeenCalledTimes(2);
  });

  it('holds browser push through quiet hours with email and SMS, then releases all three', async () => {
    // This used to pin the opposite: browser delivered at 12:00 inside a
    // 11:00→13:00 window while email and SMS waited. Since the owner decision
    // on #343 (2026-09-17) quiet hours mean the same thing on every channel,
    // and the day's reminder goes out when they end.
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      notificationPreferences(userId, {
        browser: true,
        email: true,
        sms: true,
        phone: '+15551234567',
        phoneVerified: true,
        dndStart: '11:00',
        dndEnd: '13:00',
      })
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    // 12:00, inside quiet hours: nothing is attempted, and no channel's slot
    // is reserved, push included.
    expect(await remindHousehold('hh', NOW)).toBe(0);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
    expect([...markers.keys()].filter((k) => k.includes('REMINDED#'))).toEqual([]);

    // 13:00, the half-open end: all three go out together.
    const quietHoursEnd = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await remindHousehold('hh', quietHoursEnd)).toBe(1);
    expect(vi.mocked(notifier.sendToUser).mock.calls[0][2]).toMatchObject({
      channels: ['browser', 'email', 'sms'],
    });
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#browser')).toBe(true);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#email')).toBe(true);
    expect(markers.has('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh#CHANNEL#sms')).toBe(true);
  });

  it.each([
    ['original user/day marker', 'REMINDED#2026-06-01'],
    ['household aggregate marker', 'REMINDED#2026-06-01#HOUSEHOLD#hh'],
  ])('treats an unexpired %s as all-channel completion', async (_name, legacySk) => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      notificationPreferences(userId, {
        browser: true,
        email: true,
        sms: true,
        phone: '+15551234567',
        phoneVerified: true,
      })
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);
    markers.set(`USER#u1|${legacySk}`, {
      PK: 'USER#u1',
      SK: legacySk,
      status: 'sent',
      ttl: Math.floor(NOW.getTime() / 1000) + 60 * 60,
    });

    expect(await remindHousehold('hh', NOW)).toBe(0);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('checks the original UTC-dated aggregate marker across a local-date boundary', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    const boundary = new Date('2026-06-02T00:30:00Z'); // June 1 in Los Angeles
    vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
      notificationPreferences(userId, { timezone: 'America/Los_Angeles' })
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);
    markers.set('USER#u1|REMINDED#2026-06-02', {
      PK: 'USER#u1',
      SK: 'REMINDED#2026-06-02',
      status: 'sent',
      ttl: Math.floor(boundary.getTime() / 1000) + 60 * 60,
    });

    expect(await remindHousehold('hh', boundary)).toBe(0);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('ignores an aggregate compatibility marker after its TTL expires', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);
    markers.set('USER#u1|REMINDED#2026-06-01#HOUSEHOLD#hh', {
      PK: 'USER#u1',
      SK: 'REMINDED#2026-06-01#HOUSEHOLD#hh',
      status: 'sent',
      ttl: Math.floor(NOW.getTime() / 1000) - 1,
    });

    expect(await remindHousehold('hh', NOW)).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
  });

  it('skips tasks belonging to non-active (died/gave-away) plants', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']); // 'dead-plant' is absent
    await mockNoPestOptIns();

    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: past, plantId: 'dead-plant', assignedTo: 'u1' },
    ] as never);

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(0);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('skips plant and member reads entirely when nothing is due', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const plants = await import('../../../src/services/plantService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    const markers = await mockConditionalMarkerStore();
    await mockNoPestOptIns();

    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
    // Pre-claim the pest marker so the daily pest path is also a no-op.
    markers.set('HOUSEHOLD#hh|PEST_CHECK#2026-06-01', {
      PK: 'HOUSEHOLD#hh',
      SK: 'PEST_CHECK#2026-06-01',
    });

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(0);
    expect(plants.getPlants).not.toHaveBeenCalled();
    expect(household.getHouseholdMembers).not.toHaveBeenCalled();
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  describe('vacation mode (care handoff)', () => {
    const windowFor = (userId: string, coveredBy: string) =>
      new Map([
        [
          userId,
          {
            householdId: 'hh',
            userId,
            coveredBy,
            coveredByName: 'B',
            startDate: '2026-05-25T00:00:00.000Z',
            endDate: '2026-06-05T00:00:00.000Z',
            createdBy: userId,
            createdAt: '',
          },
        ],
      ]);

    it("redirects an away member's tasks to coveredBy with a covering note; the away member gets nothing", async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();
      await mockActivePlants(['p1']);
      await mockNoPestOptIns();

      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      // u1 (A) is away, covered by u2 (B).
      vi.mocked(tasks.getActiveVacationMap).mockResolvedValueOnce(windowFor('u1', 'u2') as never);
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { nextDue: past, plantId: 'p1', assignedTo: 'u1', assignedToName: 'A' },
      ] as never);

      const sent = await remindHousehold('hh', NOW);
      expect(sent).toBe(1);
      expect(notifier.sendToUser).toHaveBeenCalledOnce();
      const [recipient, payload] = vi.mocked(notifier.sendToUser).mock.calls[0];
      // Delivered to the cover, not the away member…
      expect(recipient.userId).toBe('u2');
      // …with the handoff called out in the message.
      const body = (payload as { body: string }).body;
      // The cover is told WHO they are covering and until when — the window's
      // endDate, rendered in the recipient's zone.
      expect(body).toContain("You're covering for A, who is away until June 5, 2026.");
      // …and the summary never prints a zero bucket.
      expect(body).not.toContain('0 ');
    });

    it('after the window expires, reminders revert to the original assignee (auto-revert)', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();
      await mockActivePlants(['p1']);
      await mockNoPestOptIns();

      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      // Window over → getActiveVacationMap (which filters by start/end)
      // returns nothing. No task data was ever rewritten, so routing simply
      // falls back to assignedTo.
      vi.mocked(tasks.getActiveVacationMap).mockResolvedValueOnce(new Map() as never);
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { nextDue: past, plantId: 'p1', assignedTo: 'u1', assignedToName: 'A' },
      ] as never);

      const sent = await remindHousehold('hh', NOW);
      expect(sent).toBe(1);
      const [recipient, payload] = vi.mocked(notifier.sendToUser).mock.calls[0];
      expect(recipient.userId).toBe('u1');
      expect((payload as { body: string }).body).not.toContain('covering for');
    });

    it('falls back to the unassigned roll-up when the cover has left the household', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();
      await mockActivePlants(['p1']);
      await mockNoPestOptIns();

      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      // u1 away, but the designated cover is no longer a member.
      vi.mocked(tasks.getActiveVacationMap).mockResolvedValueOnce(
        windowFor('u1', 'u-gone') as never
      );
      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
        { nextDue: soon, plantId: 'p1', assignedTo: 'u1', assignedToName: 'A' },
      ] as never);

      const sent = await remindHousehold('hh', NOW);
      // Away member (u1) is skipped; the task rolls up to everyone else.
      expect(sent).toBe(1);
      expect(vi.mocked(notifier.sendToUser).mock.calls[0][0].userId).toBe('u2');
    });
  });

  it('hands the active-plant-filtered due list to auto-handoff and survives its failure', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const escalation = await import('../../../src/services/escalation.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']); // p-dead is not active
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { id: 'live', nextDue: past, plantId: 'p1', assignedTo: 'u1' },
      { id: 'dead', nextDue: past, plantId: 'p-dead', assignedTo: 'u1' },
    ] as never);
    vi.mocked(escalation.runEscalations).mockRejectedValueOnce(new Error('ddb hiccup'));

    // The reminder still goes out, and the hook saw only the live-plant task.
    expect(await remindHousehold('hh', NOW)).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
    expect(escalation.runEscalations).toHaveBeenCalledOnce();
    const [hh, due, when] = vi.mocked(escalation.runEscalations).mock.calls[0];
    expect(hh).toBe('hh');
    expect((due as Array<{ id: string }>).map((t) => t.id)).toEqual(['live']);
    expect(when).toBe(NOW);
  });

  it('remindAllHouseholds scans every household and survives one failing', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindAllHouseholds } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['hhA', 'hhB']);
    vi.mocked(tasks.getTasksDueBy).mockImplementation((id: string) => {
      if (id === 'hhA') throw new Error('boom'); // hhA fails…
      return Promise.resolve([{ nextDue: soon, plantId: 'p1', assignedTo: 'u1' }] as never);
    });
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([
      { ...memberA, householdId: 'hhB' },
    ] as never);

    const result = await remindAllHouseholds(NOW);
    // …but hhB is still processed.
    expect(result.households).toBe(2);
    expect(result.sent).toBe(1);
    // …and the failure is counted, not folded into "processed".
    expect(result.failed).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
  });

  // #461. The per-household catch logs at WARN — below every metric filter —
  // and the handler then returns normally, so an hour in which every household
  // failed produced no Lambda error, nothing in the DLQ and no data point
  // anywhere: byte-identical, from the outside, to an hour with nothing due.
  // These counters have to leave the function as a structured line before any
  // alarm can be built on them.
  it('emits a run summary carrying households/sent/failed, so an all-fail hour is countable', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const { logger } = await import('../../../src/utils/logger.js');
    const { remindAllHouseholds } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['hhA', 'hhB']);
    vi.mocked(tasks.getTasksDueBy).mockRejectedValue(new Error('ddb down'));

    const result = await remindAllHouseholds(NOW);
    expect(result).toMatchObject({ households: 2, sent: 0, failed: 2 });

    const summary = vi
      .mocked(logger.info)
      .mock.calls.map(([fields]) => fields as Record<string, unknown>)
      .find((fields) => fields?.msg === 'reminders.run_complete');
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ households: 2, sent: 0, failed: 2 });
  });

  // #458. The serial loop had no clock in it: past a few hundred households
  // it ran past the 30-second Lambda timeout and was KILLED wherever it
  // happened to be, and EventBridge's retry restarted it at household #1 and
  // died in the same place. The households in the tail were not delayed, they
  // were unreachable — and the run summary said nothing, because there was no
  // summary from a killed process at all.
  it('stops on its deadline and reports what it could not reach, instead of being killed mid-list', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const { logger } = await import('../../../src/utils/logger.js');
    const { remindAllHouseholds } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();

    vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['hhA', 'hhB']);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { nextDue: soon, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    // A budget that is already spent — the state the old loop reached by
    // running into the timeout, except now it is observed rather than fatal.
    const result = await remindAllHouseholds(NOW, { deadlineAt: Date.now() - 1 });

    expect(result.households).toBe(2);
    expect(result.attempted).toBe(0);
    expect(result.truncated).toBe(true);
    // Nothing was reminded, and the summary line says so rather than reading
    // like a calm hour: `households: 2, sent: 0` on its own is exactly what a
    // quiet hour looks like.
    const summary = vi
      .mocked(logger.info)
      .mock.calls.map(([fields]) => fields as Record<string, unknown>)
      .find((fields) => fields?.msg === 'reminders.run_complete');
    expect(summary).toMatchObject({ households: 2, attempted: 0, sent: 0, truncated: true });
  });

  describe('pest alerts wiring', () => {
    it('delivers pest alerts to opted-in members and marks AFTER successful delivery', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      // Only u1 opted in to pest alerts.
      vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) => {
        return { pestAlerts: userId === 'u1' } as never;
      });
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue({
        alerts: [
          {
            plantId: 'p1',
            plantName: 'Monstera',
            pestId: 42,
            pestName: 'Spider mites',
            message: 'Your Monstera may be entering Spider mites season — give it a quick check.',
          },
        ],
        dataUnavailable: false,
      });
      vi.mocked(notifier.sendToUser).mockResolvedValue({
        delivered: true,
        dndSuppressedOnly: false,
        channels: {
          browser: 'skipped',
          email: 'delivered',
          sms: 'skipped',
        },
      });

      await remindHousehold('hh', NOW);

      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledWith('hh', NOW);
      expect(notifier.sendToUser).toHaveBeenCalledOnce();
      expect(vi.mocked(notifier.sendToUser).mock.calls[0][0].userId).toBe('u1');
      expect(vi.mocked(notifier.sendToUser).mock.calls[0][1]).toMatchObject({
        tag: 'pest-alert-hh-p1-42',
        url: 'http://localhost:3000/plants/p1',
      });
      expect(pestAlerts.markAlerted).toHaveBeenCalledWith('u1', 'p1', 42, NOW);
      // Delivery happened before the suppression marker was written.
      expect(vi.mocked(pestAlerts.markAlerted).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(notifier.sendToUser).mock.invocationCallOrder[0]
      );
    });

    it('does NOT write the 90-day suppression marker when delivery fails', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue({
        alerts: [
          { plantId: 'p1', plantName: 'M', pestId: 42, pestName: 'Mites', message: 'check' },
        ],
        dataUnavailable: false,
      });
      vi.mocked(notifier.sendToUser).mockRejectedValue(new Error('SES down'));

      await remindHousehold('hh', NOW);
      expect(pestAlerts.markAlerted).not.toHaveBeenCalled();
    });

    it('retries only failed pest-alert recipients without suppressing them for 90 days', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue({
        alerts: [
          { plantId: 'p1', plantName: 'M', pestId: 42, pestName: 'Mites', message: 'check' },
        ],
        dataUnavailable: false,
      });
      const deliveredUsers = new Set<string>();
      vi.mocked(pestAlerts.wasAlerted).mockImplementation(async (userId: string) =>
        deliveredUsers.has(userId)
      );
      vi.mocked(pestAlerts.markAlerted).mockImplementation(async (userId: string) => {
        deliveredUsers.add(userId);
      });
      vi.mocked(notifier.sendToUser)
        .mockResolvedValueOnce({
          delivered: true,
          dndSuppressedOnly: false,
          channels: { browser: 'skipped', email: 'delivered', sms: 'skipped' },
        })
        .mockResolvedValueOnce({
          delivered: false,
          dndSuppressedOnly: false,
          channels: { browser: 'skipped', email: 'failed', sms: 'skipped' },
        })
        .mockResolvedValueOnce({
          delivered: true,
          dndSuppressedOnly: false,
          channels: { browser: 'skipped', email: 'delivered', sms: 'skipped' },
        });

      await remindHousehold('hh', NOW);
      await remindHousehold('hh', new Date(NOW.getTime() + 60 * 60 * 1000));

      expect(
        vi.mocked(notifier.sendToUser).mock.calls.map(([recipient]) => recipient.userId)
      ).toEqual(['u1', 'u2', 'u2']);
      expect(pestAlerts.markAlerted).toHaveBeenCalledTimes(2);
      expect(deliveredUsers).toEqual(new Set(['u1', 'u2']));
      vi.mocked(pestAlerts.wasAlerted).mockResolvedValue(false);
    });

    it('does not mark or suppress a pest alert when dispatch resolves without a delivery', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const notifier = await import('../../../src/services/notifier.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      const markers = await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue({
        alerts: [
          { plantId: 'p1', plantName: 'M', pestId: 42, pestName: 'Mites', message: 'check' },
        ],
        dataUnavailable: false,
      });
      // Dry-run, DND, or an all-provider failure resolves normally with
      // delivered=false; this used to be mistaken for a successful send.
      vi.mocked(notifier.sendToUser).mockResolvedValue({
        delivered: false,
        dndSuppressedOnly: false,
        channels: {
          browser: 'skipped',
          email: 'failed',
          sms: 'skipped',
        },
      });

      await remindHousehold('hh', NOW);

      expect(pestAlerts.markAlerted).not.toHaveBeenCalled();
      // The daily evaluation claim is released so the hourly job can retry.
      expect(markers.has('HOUSEHOLD#hh|PEST_CHECK#2026-06-01')).toBe(false);
    });

    it('runs the pest evaluation at most once per household per day', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue({
        alerts: [],
        dataUnavailable: false,
      });

      await remindHousehold('hh', NOW);
      await remindHousehold('hh', new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledOnce();
    });

    it('retries later the same day when Perenual data was unavailable, instead of silently losing the day', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      // First hour: Perenual's budget is exhausted for this plant.
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValueOnce({
        alerts: [],
        dataUnavailable: true,
      });

      await remindHousehold('hh', NOW);
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledOnce();

      // A later hour, same UTC day: must NOT be treated as "already checked"
      // — the marker should have been cleared after the unavailable result.
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValueOnce({
        alerts: [],
        dataUnavailable: false,
      });
      await remindHousehold('hh', new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledTimes(2);
    });

    it('retries later the same day when evaluation THROWS outright (regression: crash must not look like "checked")', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      // First hour: evaluatePestAlerts crashes outright (not a reported
      // dataUnavailable result) — e.g. an unexpected exception, not a
      // graceful "Perenual unreachable" outcome.
      vi.mocked(pestAlerts.evaluatePestAlerts).mockRejectedValueOnce(new Error('boom'));

      // remindHousehold must not throw — pest alerts are best-effort — and
      // must not leave the household wrongly marked "checked today".
      await expect(remindHousehold('hh', NOW)).resolves.not.toThrow();
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledOnce();

      // A later hour, same UTC day: must retry rather than treat the crash
      // as "nothing to report".
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValueOnce({
        alerts: [],
        dataUnavailable: false,
      });
      await remindHousehold('hh', new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry when everything was fully evaluated (no data-unavailable flag)', async () => {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      const pestAlerts = await import('../../../src/services/pestAlerts.js');
      const { remindHousehold } = await import('../../../src/services/reminders.js');
      await mockConditionalMarkerStore();

      vi.mocked(tasks.getTasksDueBy).mockResolvedValue([] as never);
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: true } as never);
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue({
        alerts: [],
        dataUnavailable: false,
      });

      await remindHousehold('hh', NOW);
      await remindHousehold('hh', new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledOnce();
    });
  });
});

/**
 * The daily reminder's far edge (#478).
 *
 * `getTasksDueBy` queries `GSI1SK <= cutoff` with no lower bound, so before
 * this the window included everything overdue at any age — which is why a
 * household that fell behind was reminded every single morning about a list
 * that only grew, while a household keeping up heard from us only when
 * something was actually due.
 */
describe('reminders — overdue decay', () => {
  /**
   * The pest-alert cases above install `sendToUser` with `mockResolvedValue`,
   * which survives `clearAllMocks` — so this block restores the module
   * factory's per-channel behaviour instead of inheriting whichever result ran
   * last. Without it these tests pass or fail on file order, not on the code.
   */
  async function mockDeliveredSends() {
    const notifier = await import('../../../src/services/notifier.js');
    vi.mocked(notifier.sendToUser).mockImplementation((async (
      _recipient: unknown,
      _payload: unknown,
      options?: { channels?: Array<'browser' | 'email' | 'sms'> }
    ) => {
      const selected = options?.channels ?? ['email'];
      return {
        delivered: selected.length > 0,
        dndSuppressedOnly: false,
        channels: {
          browser: selected.includes('browser') ? 'delivered' : 'skipped',
          email: selected.includes('email') ? 'delivered' : 'skipped',
          sms: selected.includes('sms') ? 'delivered' : 'skipped',
        },
      };
    }) as never);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await mockDeliveredSends();
  });

  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it('sends no reminder at all when the whole backlog has aged out, and does not read members', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold, REMINDER_OVERDUE_DECAY_DAYS } =
      await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      {
        id: 't1',
        nextDue: daysAgo(REMINDER_OVERDUE_DECAY_DAYS + 1),
        plantId: 'p1',
        assignedTo: 'u1',
      },
      { id: 't2', nextDue: daysAgo(90), plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    expect(await remindHousehold('hh', NOW)).toBe(0);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
    // The reminder's own vacation read is not paid for either. (The pest-alert
    // pass at the end of `remindHousehold` has its own member read and is
    // unaffected by the decay, so `getHouseholdMembers` is not asserted here.)
    expect(tasks.getActiveVacationMap).not.toHaveBeenCalled();
  });

  it('still hands the escalation pass the UNFILTERED due list', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const escalation = await import('../../../src/services/escalation.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { id: 'ancient', nextDue: daysAgo(60), plantId: 'p1', assignedTo: 'u1' },
      { id: 'recent', nextDue: past, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    await remindHousehold('hh', NOW);
    // Auto-handoff has its own floor and its own at-most-once write; the
    // reminder's display rule must not silently change who a task hands to.
    const [, due] = vi.mocked(escalation.runEscalations).mock.calls[0];
    expect((due as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(['ancient', 'recent']);
  });

  it('counts aged-out rows in the body without listing them, and keeps them out of the subject', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1', 'p2', 'p3']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { id: 'fresh', nextDue: past, plantId: 'p1', assignedTo: 'u1', type: 'water' },
      { id: 'old1', nextDue: daysAgo(40), plantId: 'p2', assignedTo: 'u1', type: 'water' },
      { id: 'old2', nextDue: daysAgo(21), plantId: 'p3', assignedTo: null, type: 'water' },
    ] as never);

    expect(await remindHousehold('hh', NOW)).toBe(1);
    const payload = vi.mocked(notifier.sendToUser).mock.calls[0][1] as {
      title: string;
      body: string;
    };
    expect(payload.body).toContain('Plant p1 — water');
    // Neither aged-out plant is named, and neither day count is printed.
    expect(payload.body).not.toContain('Plant p2');
    expect(payload.body).not.toContain('Plant p3');
    expect(payload.body).not.toContain('40 days overdue');
    expect(payload.body).toContain('2 more tasks have been waiting 14 days or longer.');
    expect(payload.title).toBe('Plant care reminder: 1 due today');
  });

  it('keeps a task one day short of the edge in the daily list', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold, REMINDER_OVERDUE_DECAY_DAYS } =
      await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      {
        id: 'edge',
        nextDue: daysAgo(REMINDER_OVERDUE_DECAY_DAYS - 1),
        plantId: 'p1',
        assignedTo: 'u1',
        type: 'water',
      },
    ] as never);

    expect(await remindHousehold('hh', NOW)).toBe(1);
    const payload = vi.mocked(notifier.sendToUser).mock.calls[0][1] as { body: string };
    expect(payload.body).toContain(
      `Plant p1 — water, ${REMINDER_OVERDUE_DECAY_DAYS - 1} days overdue`
    );
    expect(payload.body).not.toContain('waiting');
  });

  it('never ages out a task whose due date could not be read', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold, isRestingOverdue } =
      await import('../../../src/services/reminders.js');
    // An unreadable date is not an old one — we do not know how overdue it is.
    expect(isRestingOverdue('not-a-date', NOW)).toBe(false);
    expect(isRestingOverdue(null, NOW)).toBe(false);
    expect(isRestingOverdue(undefined, NOW)).toBe(false);

    await mockConditionalMarkerStore();
    await mockActivePlants(['p1']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { id: 'broken', nextDue: 'not-a-date', plantId: 'p1', assignedTo: 'u1', type: 'water' },
    ] as never);

    expect(await remindHousehold('hh', NOW)).toBe(1);
    const payload = vi.mocked(notifier.sendToUser).mock.calls[0][1] as { body: string };
    expect(payload.body).toContain('due date could not be read');
  });

  it('splits the count per member: unassigned aged-out rows land on everyone, assigned ones do not', async () => {
    const household = await import('../../../src/services/householdService.js');
    const tasks = await import('../../../src/services/taskService.js');
    const notifier = await import('../../../src/services/notifier.js');
    const { remindHousehold } = await import('../../../src/services/reminders.js');
    await mockConditionalMarkerStore();
    await mockActivePlants(['p1', 'p2', 'p3']);
    await mockNoPestOptIns();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      { id: 'fresh', nextDue: past, plantId: 'p1', assignedTo: null, type: 'water' },
      { id: 'oldA', nextDue: daysAgo(30), plantId: 'p2', assignedTo: 'u1', type: 'water' },
      { id: 'oldFree', nextDue: daysAgo(30), plantId: 'p3', assignedTo: null, type: 'water' },
    ] as never);

    expect(await remindHousehold('hh', NOW)).toBe(2);
    const bodies = vi
      .mocked(notifier.sendToUser)
      .mock.calls.map(([recipient, payload]) => [
        (recipient as { userId: string }).userId,
        (payload as { body: string }).body,
      ]);
    const forA = bodies.find(([id]) => id === 'u1')![1];
    const forB = bodies.find(([id]) => id === 'u2')![1];
    // u1 owns one aged-out task and shares the unclaimed one: 2.
    expect(forA).toContain('2 more tasks have been waiting 14 days or longer.');
    // u2 owns none, and sees only the unclaimed one: 1, in the singular.
    expect(forB).toContain('1 more task has been waiting 14 days or longer.');
  });
});
