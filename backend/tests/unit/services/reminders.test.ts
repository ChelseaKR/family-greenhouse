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
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
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
    timezoneSet: false,
    pestAlerts: false,
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: '',
    ...over,
  };
}

async function mockActivePlants(ids: string[] = ['p1']) {
  const plants = await import('../../../src/services/plantService.js');
  vi.mocked(plants.getPlants).mockResolvedValue(ids.map((id) => ({ id })) as never);
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
      { nextDue: past, plantId: 'p1', assignedTo: 'u1' },
      { nextDue: soon, plantId: 'p1', assignedTo: 'u1' },
    ] as never);

    const sent = await remindHousehold('hh', NOW);
    expect(sent).toBe(1);
    expect(tasks.getTasksDueBy).toHaveBeenCalledOnce(); // one query per household
    expect(notifier.sendToUser).toHaveBeenCalledOnce();
    const [recipient, payload] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect(recipient).toEqual({ userId: 'u1', email: 'a@x.com' });
    expect((payload as { body: string }).body).toBe(
      '1 ready for some catch-up care, 1 coming up soon'
    );
    expect(payload).toMatchObject({
      tag: 'reminder-hh-2026-06-01',
      url: 'http://localhost:3000/tasks?filter=due',
    });
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
    // Nothing pinned this before 2026-08-28. Every `nextDue` fixture in this
    // file was one of two constants, `soon` (NOW + 1h) and `past` (NOW - 1h),
    // both trivially inside the 24h window and on the same UTC day as the
    // scan. The window boundary was never crossed by any test and the scan
    // instant was never varied against a fixed due date, so a change to the
    // window or to the dedupe key could not turn this suite red.
    //
    // `getTasksDueBy` is mocked without regard for its cutoff everywhere else
    // in this file, which is why the window was invisible. Here the mock
    // honours the cutoff, so these assertions describe real behaviour.
    //
    // CHARACTERIZATION, not endorsement. The pattern below is the defect
    // #343 reports, measured rather than assumed — the issue's own
    // walk-through gets the second fire wrong. Any fix must edit these
    // expectations deliberately.

    // Tue Jun 9, 22:00 America/New_York. The task list calls this "Today"
    // for all of Tuesday (frontend/src/utils/date.ts isToday, browser-local).
    const DUE = '2026-06-10T02:00:00.000Z';

    async function arrange(timezone: string) {
      const household = await import('../../../src/services/householdService.js');
      const tasks = await import('../../../src/services/taskService.js');
      const prefs = await import('../../../src/services/notificationPrefs.js');
      await mockConditionalMarkerStore();
      await mockActivePlants(['p1']);
      vi.mocked(prefs.getPreferences).mockImplementation(async (userId: string) =>
        notificationPreferences(userId, { timezone })
      );
      vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
      // The service asks for tasks due by `now + 24h`; honour that.
      vi.mocked(tasks.getTasksDueBy).mockImplementation(
        async (_householdId: string, cutoff: string) =>
          (cutoff >= DUE ? [{ nextDue: DUE, plantId: 'p1', assignedTo: 'u1' }] : []) as never
      );
      return await import('../../../src/services/reminders.js');
    }

    it('stays quiet while the task is outside the rolling 24h window', async () => {
      const { remindHousehold } = await arrange('America/New_York');
      // Mon Jun 8, 18:00 EDT — cutoff Jun 9 22:00Z, still short of DUE.
      expect(await remindHousehold('hh', new Date('2026-06-08T22:00:00.000Z'))).toBe(0);
    });

    it('fires on the EVENING BEFORE the day the app calls the task due', async () => {
      const { remindHousehold } = await arrange('America/New_York');
      // Mon Jun 8, 22:00 EDT. The window opens exactly 24h before DUE, so the
      // first eligible hourly tick is always the night before, whatever
      // minute EventBridge happens to fire on.
      expect(await remindHousehold('hh', new Date('2026-06-09T02:00:00.000Z'))).toBe(1);
    });

    it('fires AGAIN at local midnight, because the dedupe key is a local date', async () => {
      const { remindHousehold } = await arrange('America/New_York');
      expect(await remindHousehold('hh', new Date('2026-06-09T02:00:00.000Z'))).toBe(1);
      // Tue Jun 9, 00:00 EDT. New local date, fresh marker. This is the
      // midnight push the issue flags as reaching browser-only users through
      // their quiet hours: browser delivery is exempt from the DND check
      // (reminders.ts), and the first eligible tick of a local day is ~00:0x.
      expect(await remindHousehold('hh', new Date('2026-06-09T04:00:00.000Z'))).toBe(1);
    });

    it('is then silent for the WHOLE due day, including the moment it comes due', async () => {
      const { remindHousehold } = await arrange('America/New_York');
      await remindHousehold('hh', new Date('2026-06-09T02:00:00.000Z')); // Mon 22:00
      await remindHousehold('hh', new Date('2026-06-09T04:00:00.000Z')); // Tue 00:00
      // Every remaining tick of Tuesday local is deduped against the
      // 2026-06-09 marker burned at midnight — including 22:00, when the task
      // actually becomes due, and the whole working day in between.
      for (const at of [
        '2026-06-09T12:00:00.000Z', // Tue 08:00
        '2026-06-09T16:00:00.000Z', // Tue 12:00
        '2026-06-09T22:00:00.000Z', // Tue 18:00
        '2026-06-10T00:00:00.000Z', // Tue 20:00
        '2026-06-10T02:00:00.000Z', // Tue 22:00 — the due instant itself
      ]) {
        expect(await remindHousehold('hh', new Date(at))).toBe(0);
      }
      // The next reminder is Wed 00:00, after the task was already due.
      expect(await remindHousehold('hh', new Date('2026-06-10T04:00:00.000Z'))).toBe(1);
    });

    it('a UTC-defaulted recipient is deduped on UTC days, not their own', async () => {
      // Every user who has never saved quiet hours was 'UTC' before the
      // companion fix in this pass, whatever zone they live in.
      const { remindHousehold } = await arrange('UTC');
      expect(await remindHousehold('hh', new Date('2026-06-09T02:00:00.000Z'))).toBe(1);
      // Still UTC Jun 9 → deduped, though it is Tuesday evening for a
      // recipient in New York.
      expect(await remindHousehold('hh', new Date('2026-06-09T23:00:00.000Z'))).toBe(0);
      // UTC Jun 10 → fires again.
      expect(await remindHousehold('hh', new Date('2026-06-10T00:00:00.000Z'))).toBe(1);
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
    expect((vi.mocked(notifier.sendToUser).mock.calls[0][1] as { body: string }).body).toBe(
      '2 tasks coming up in the next 24h'
    );
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

  it('does not let browser delivery during DND suppress later email and SMS', async () => {
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
    vi.mocked(notifier.sendToUser)
      .mockResolvedValueOnce({
        delivered: true,
        dndSuppressedOnly: false,
        channels: {
          browser: 'delivered',
          email: 'skipped',
          sms: 'skipped',
        },
      })
      .mockResolvedValueOnce({
        delivered: true,
        dndSuppressedOnly: false,
        channels: {
          browser: 'skipped',
          email: 'delivered',
          sms: 'delivered',
        },
      });

    expect(await remindHousehold('hh', NOW)).toBe(1);
    expect(vi.mocked(notifier.sendToUser).mock.calls[0][2]).toMatchObject({
      channels: ['browser'],
    });

    const dndEnd = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await remindHousehold('hh', dndEnd)).toBe(1);
    expect(vi.mocked(notifier.sendToUser).mock.calls[1][2]).toMatchObject({
      channels: ['email', 'sms'],
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
      expect((payload as { body: string }).body).toBe(
        '1 ready for some catch-up care, 0 coming up soon (covering for A)'
      );
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
