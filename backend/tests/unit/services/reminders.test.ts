import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
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
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
}));
vi.mock('../../../src/services/pestAlerts.js', () => ({
  evaluatePestAlerts: vi.fn(),
  markAlerted: vi.fn(),
}));
vi.mock('../../../src/services/notifier.js', () => ({
  sendToUser: vi.fn(),
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

async function mockActivePlants(ids: string[] = ['p1']) {
  const plants = await import('../../../src/services/plantService.js');
  vi.mocked(plants.getPlants).mockResolvedValue(ids.map((id) => ({ id })) as never);
}

async function mockNoPestOptIns() {
  const prefs = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(prefs.getPreferences).mockResolvedValue({ pestAlerts: false } as never);
}

/**
 * Simulates DynamoDB conditional puts: every marker PK|SK is remembered, and
 * a second conditional put on the same key throws ConditionalCheckFailed —
 * exactly the dedupe behavior the service relies on across hourly runs.
 */
async function mockConditionalMarkerStore() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const markers = new Set<string>();
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { input } = cmd as { input: { Item: { PK: string; SK: string } } };
    const key = `${input.Item.PK}|${input.Item.SK}`;
    if (markers.has(key)) {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    markers.add(key);
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
    expect((payload as { body: string }).body).toBe('1 overdue, 1 due soon');
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
      '2 tasks due in the next 24h'
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
    expect(markers.has('USER#u1|REMINDED#2026-06-01')).toBe(true);

    // Hour 2 (same task still due): marker present → no second send.
    const hourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(await remindHousehold('hh', hourLater)).toBe(0);
    expect(notifier.sendToUser).toHaveBeenCalledOnce();

    // Next day: fresh marker key → reminder goes out again.
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await remindHousehold('hh', nextDay)).toBe(1);
    expect(notifier.sendToUser).toHaveBeenCalledTimes(2);
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
    markers.add('HOUSEHOLD#hh|PEST_CHECK#2026-06-01');

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
      expect((payload as { body: string }).body).toBe('1 overdue, 0 due soon (covering for A)');
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
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue([
        {
          plantId: 'p1',
          plantName: 'Monstera',
          pestId: 42,
          pestName: 'Spider mites',
          message: 'Your Monstera may be entering Spider mites season — give it a quick check.',
        },
      ]);
      vi.mocked(notifier.sendToUser).mockResolvedValue(undefined as never);

      await remindHousehold('hh', NOW);

      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledWith('hh', NOW);
      expect(notifier.sendToUser).toHaveBeenCalledOnce();
      expect(vi.mocked(notifier.sendToUser).mock.calls[0][0].userId).toBe('u1');
      expect(pestAlerts.markAlerted).toHaveBeenCalledWith('p1', 42);
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
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue([
        { plantId: 'p1', plantName: 'M', pestId: 42, pestName: 'Mites', message: 'check' },
      ]);
      vi.mocked(notifier.sendToUser).mockRejectedValue(new Error('SES down'));

      await remindHousehold('hh', NOW);
      expect(pestAlerts.markAlerted).not.toHaveBeenCalled();
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
      vi.mocked(pestAlerts.evaluatePestAlerts).mockResolvedValue([]);

      await remindHousehold('hh', NOW);
      await remindHousehold('hh', new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(pestAlerts.evaluatePestAlerts).toHaveBeenCalledOnce();
    });
  });
});
