import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  listVacationWindows: vi.fn(async () => []),
}));
vi.mock('../../../src/services/notificationPrefs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/notificationPrefs.js')>(
    '../../../src/services/notificationPrefs.js'
  );
  return { ...actual, getPreferences: vi.fn() };
});
vi.mock('../../../src/services/notifier.js', () => ({
  sendToUser: vi.fn(async () => ({
    delivered: true,
    dndSuppressedOnly: false,
    channels: { browser: 'skipped', email: 'delivered', sms: 'skipped' },
  })),
}));
vi.mock('../../../src/services/activity.js', () => ({
  recordActivity: vi.fn(async () => undefined),
}));

const NOW = new Date('2026-06-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const overdueBy = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const sam = {
  householdId: 'hh',
  userId: 'sam',
  name: 'Sam',
  email: 'sam@x.com',
  role: 'admin' as const,
  joinedAt: '',
};
const priya = {
  householdId: 'hh',
  userId: 'priya',
  name: 'Priya',
  email: 'priya@x.com',
  role: 'member' as const,
  joinedAt: '',
};
const lee = {
  householdId: 'hh',
  userId: 'lee',
  name: 'Lee',
  email: 'lee@x.com',
  role: 'member' as const,
  joinedAt: '',
};

function prefs(
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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    householdId: 'hh',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: overdueBy(6),
    assignedTo: 'sam',
    assignedToName: 'Sam',
    assignmentSource: null,
    notes: null,
    createdBy: 'sam',
    createdAt: '',
    ...overrides,
  };
}

type Sent = { kind: string; input: Record<string, any> };

/**
 * Metadata row + a conditional task store: the escalation Update on a task
 * succeeds once per (task, nextDue) and throws ConditionalCheckFailed after —
 * exactly what DynamoDB does for the once-only condition.
 */
async function mockStore(meta: Record<string, unknown>) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const escalated = new Map<string, string>(); // SK -> escalatedForDue
  const sent: Sent[] = [];
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const c = cmd as Sent;
    sent.push(c);
    if (c.kind === 'Get') return { Item: meta } as never;
    if (c.kind === 'Update' && c.input.Key.SK.startsWith('TASK#')) {
      const due = c.input.ExpressionAttributeValues[':due'];
      if (escalated.get(c.input.Key.SK) === due) {
        const err = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      escalated.set(c.input.Key.SK, due);
      return {} as never;
    }
    return {} as never;
  });
  return { sent, escalated };
}

async function members(list = [sam, priya, lee]) {
  const household = await import('../../../src/services/householdService.js');
  vi.mocked(household.getHouseholdMembers).mockResolvedValue(list as never);
}

async function allPrefs(over: Record<string, Partial<NotificationPreferences>> = {}) {
  const p = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(p.getPreferences).mockImplementation(async (userId: string) =>
    prefs(userId, over[userId])
  );
}

describe('escalation — rule storage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads rule + plan from one projected GetItem and normalises both', async () => {
    const { sent } = await mockStore({ escalateAfterDays: 7, planId: 'garden' });
    const { getEscalationRule } = await import('../../../src/services/escalation.js');
    expect(await getEscalationRule('hh')).toEqual({ escalateAfterDays: 7, planId: 'garden' });
    expect(sent).toHaveLength(1);
    // #476: subscriptionStatus and lifetimePlanId ride along on the SAME
    // GetItem, so consulting payment status costs no extra read.
    expect(sent[0].input.ProjectionExpression).toBe(
      'escalateAfterDays, planId, subscriptionStatus, lifetimePlanId'
    );
  });

  it.each(['past_due', 'unpaid', 'incomplete', 'paused', 'canceled'])(
    'resolves the gating plan from ENTITLEMENT: %s reads as the free tier (#476)',
    async (subscriptionStatus) => {
      // PUT /households/{id}/escalation now refuses to turn the rule ON for a
      // household mid-dunning. Without this the hourly scan would keep ACTING
      // on a rule already stored — the two halves of one feature disagreeing.
      await mockStore({ escalateAfterDays: 7, planId: 'garden', subscriptionStatus });
      const { getEscalationRule } = await import('../../../src/services/escalation.js');
      expect(await getEscalationRule('hh')).toEqual({
        escalateAfterDays: 7,
        planId: 'seedling',
      });
    }
  );

  it.each(['active', 'trialing', undefined])(
    'keeps the paid tier while the subscription is in good standing (%s) (#476)',
    async (subscriptionStatus) => {
      await mockStore({ escalateAfterDays: 7, planId: 'garden', subscriptionStatus });
      const { getEscalationRule } = await import('../../../src/services/escalation.js');
      expect((await getEscalationRule('hh')).planId).toBe('garden');
    }
  );

  it('never falls below a lifetime purchase (#476)', async () => {
    await mockStore({
      escalateAfterDays: 7,
      planId: 'seedling',
      subscriptionStatus: 'canceled',
      lifetimePlanId: 'garden',
    });
    const { getEscalationRule } = await import('../../../src/services/escalation.js');
    expect((await getEscalationRule('hh')).planId).toBe('garden');
  });

  it('a corrupt stored rule reads as off; an unknown plan reads as the free tier', async () => {
    await mockStore({ escalateAfterDays: 2, planId: 'platinum' });
    const { getEscalationRule } = await import('../../../src/services/escalation.js');
    expect(await getEscalationRule('hh')).toEqual({ escalateAfterDays: null, planId: 'seedling' });
  });

  it('refuses to persist a value under the floor (server-side, independent of the schema)', async () => {
    const { sent } = await mockStore({});
    const { setEscalationRule } = await import('../../../src/services/escalation.js');
    await expect(setEscalationRule('hh', 4)).rejects.toMatchObject({
      name: 'EscalationRuleRangeError',
    });
    await expect(setEscalationRule('hh', 61)).rejects.toMatchObject({
      name: 'EscalationRuleRangeError',
    });
    expect(sent).toHaveLength(0);
  });

  it('SETs a valid value and REMOVEs on null, both conditioned on the household existing', async () => {
    const { sent } = await mockStore({});
    const { setEscalationRule } = await import('../../../src/services/escalation.js');
    expect(await setEscalationRule('hh', 7)).toBe(7);
    expect(await setEscalationRule('hh', null)).toBeNull();
    expect(sent.map((c) => c.input.UpdateExpression)).toEqual([
      'SET escalateAfterDays = :days',
      'REMOVE escalateAfterDays',
    ]);
    for (const c of sent) expect(c.input.ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('maps a missing household to HouseholdNotFoundError', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockImplementation(async () => {
      const err = new Error('nope');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    });
    const { setEscalationRule } = await import('../../../src/services/escalation.js');
    await expect(setEscalationRule('hh', 7)).rejects.toMatchObject({
      name: 'HouseholdNotFoundError',
    });
  });
});

describe('escalation — the scan hook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('performs ZERO reads when nothing is at the 5-day floor (the common hour)', async () => {
    const { sent } = await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    const { runEscalations } = await import('../../../src/services/escalation.js');
    const summary = await runEscalations('hh', [task({ nextDue: overdueBy(4) })], NOW);
    expect(summary).toEqual({ escalated: 0, notified: 0 });
    expect(sent).toHaveLength(0);
  });

  it('with the rule off, stops after the single rule read', async () => {
    const { sent } = await mockStore({ planId: 'garden' });
    await members();
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    expect(await runEscalations('hh', [task({ nextDue: overdueBy(30) })], NOW)).toEqual({
      escalated: 0,
      notified: 0,
    });
    expect(sent).toHaveLength(1);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('is gated to plans with the household toolkit: a Seedling rule is stored but never acted on', async () => {
    const { sent } = await mockStore({ escalateAfterDays: 5, planId: 'seedling' });
    await members();
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    expect(await runEscalations('hh', [task()], NOW)).toEqual({ escalated: 0, notified: 0 });
    expect(sent).toHaveLength(1);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('stops acting on a stored rule while the card has failed, after the single rule read (#476)', async () => {
    // Every escalation sends real email. A household mid-dunning keeps its
    // stored rule — no data cleanup — and the scan resumes by itself once
    // the card is fixed.
    const { sent } = await mockStore({
      escalateAfterDays: 5,
      planId: 'garden',
      subscriptionStatus: 'past_due',
    });
    await members();
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    expect(await runEscalations('hh', [task()], NOW)).toEqual({ escalated: 0, notified: 0 });
    expect(sent).toHaveLength(1);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('puts an overdue assigned task up for grabs, tells the OTHER members once, records the event', async () => {
    const { sent } = await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const notifier = await import('../../../src/services/notifier.js');
    const activity = await import('../../../src/services/activity.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');

    const t = task();
    expect(await runEscalations('hh', [t], NOW)).toEqual({ escalated: 1, notified: 2 });

    const update = sent.find((c) => c.kind === 'Update')!;
    expect(update.input.Key).toEqual({ PK: 'HOUSEHOLD#hh', SK: 'TASK#t1' });
    expect(update.input.UpdateExpression).toContain('#assignedTo = :null');
    expect(update.input.UpdateExpression).toContain('REMOVE GSI2PK, GSI2SK');
    expect(update.input.ConditionExpression).toBe(
      'attribute_exists(PK) AND #nextDue = :due AND (attribute_not_exists(#escalatedForDue) OR #escalatedForDue <> :due)'
    );
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':due': t.nextDue,
      ':from': 'sam',
    });

    const recipients = vi
      .mocked(notifier.sendToUser)
      .mock.calls.map((c) => c[0].userId)
      .sort();
    expect(recipients).toEqual(['lee', 'priya']); // never Sam — it is not a nag
    const [, payload, options] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect(payload).toMatchObject({
      title: 'A plant task is up for grabs',
      url: 'http://localhost:3000/tasks?filter=due',
    });
    expect((payload as { body: string }).body).toContain(
      'Water for Monstera has been waiting 6 days.'
    );
    expect(options).toMatchObject({ now: NOW });

    expect(activity.recordActivity).toHaveBeenCalledWith({
      type: 'task.escalated',
      householdId: 'hh',
      actorId: 'system',
      actorName: '',
      payload: {
        taskId: 't1',
        plantId: 'p1',
        plantName: 'Monstera',
        taskType: 'water',
        previousAssigneeId: 'sam',
        previousAssigneeName: 'Sam',
        daysOverdue: 6,
        notified: 2,
      },
    });
  });

  it('an unclaimed overdue task tells everyone and records no previous holder', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const notifier = await import('../../../src/services/notifier.js');
    const activity = await import('../../../src/services/activity.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    await runEscalations('hh', [task({ assignedTo: null, assignedToName: null })], NOW);
    expect(
      vi
        .mocked(notifier.sendToUser)
        .mock.calls.map((c) => c[0].userId)
        .sort()
    ).toEqual(['lee', 'priya', 'sam']);
    expect(vi.mocked(activity.recordActivity).mock.calls[0][0].payload).toMatchObject({
      previousAssigneeId: null,
      previousAssigneeName: null,
    });
  });

  it('never twice: an overlapping run loses the conditional write and sends nothing', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    const stale = [task()]; // both runs read the same pre-escalation row
    expect(await runEscalations('hh', stale, NOW)).toEqual({ escalated: 1, notified: 2 });
    expect(await runEscalations('hh', stale, new Date(NOW.getTime() + 60 * 60 * 1000))).toEqual({
      escalated: 0,
      notified: 0,
    });
    expect(notifier.sendToUser).toHaveBeenCalledTimes(2);
  });

  it('never twice: next hour’s fresh read of the escalated row costs zero reads', async () => {
    const { sent } = await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    const { runEscalations } = await import('../../../src/services/escalation.js');
    const due = overdueBy(6);
    await runEscalations(
      'hh',
      [task({ nextDue: due, escalatedForDue: due, assignedTo: null })],
      NOW
    );
    expect(sent).toHaveLength(0);
  });

  it('escalation + claim: a claimed task still escalates after the threshold, and the claimer is not nagged', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    // A claim writes assignedTo with a null source — indistinguishable from a
    // manual assignment, and that is the point: both are explicit.
    await runEscalations('hh', [task({ assignedTo: 'priya', assignedToName: 'Priya' })], NOW);
    expect(
      vi
        .mocked(notifier.sendToUser)
        .mock.calls.map((c) => c[0].userId)
        .sort()
    ).toEqual(['lee', 'sam']);
  });

  it('escalation + vacation: a member who is away is not told', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const tasks = await import('../../../src/services/taskService.js');
    vi.mocked(tasks.listVacationWindows).mockResolvedValueOnce([
      {
        householdId: 'hh',
        userId: 'priya',
        coveredBy: 'lee',
        coveredByName: 'Lee',
        startDate: overdueBy(1),
        endDate: new Date(NOW.getTime() + 3 * DAY).toISOString(),
        createdBy: 'priya',
        createdAt: '',
      },
    ]);
    const notifier = await import('../../../src/services/notifier.js');
    const activity = await import('../../../src/services/activity.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    expect(await runEscalations('hh', [task()], NOW)).toEqual({ escalated: 1, notified: 1 });
    expect(vi.mocked(notifier.sendToUser).mock.calls.map((c) => c[0].userId)).toEqual(['lee']);
    expect(vi.mocked(activity.recordActivity).mock.calls[0][0].payload).toMatchObject({
      notified: 1,
    });
  });

  it('escalation + DND: a member inside quiet hours is not told (no queueing, by design)', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    // NOW is 12:00 UTC; Lee's window covers it.
    await allPrefs({ lee: { dndStart: '11:00', dndEnd: '13:00' } });
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    expect(await runEscalations('hh', [task()], NOW)).toEqual({ escalated: 1, notified: 1 });
    expect(vi.mocked(notifier.sendToUser).mock.calls.map((c) => c[0].userId)).toEqual(['priya']);
  });

  it('rolls several escalations into ONE notification per recipient per run', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const notifier = await import('../../../src/services/notifier.js');
    const { runEscalations } = await import('../../../src/services/escalation.js');
    const summary = await runEscalations(
      'hh',
      [
        task({ id: 'a', plantName: 'Monstera' }),
        task({
          id: 'b',
          plantName: 'Fern',
          type: 'fertilize',
          assignedTo: 'priya',
          assignedToName: 'Priya',
          nextDue: overdueBy(9),
        }),
      ],
      NOW
    );
    expect(summary).toEqual({ escalated: 2, notified: 3 });
    const calls = vi.mocked(notifier.sendToUser).mock.calls;
    expect(calls).toHaveLength(3);
    const bodyFor = (userId: string) =>
      calls.find((c) => c[0].userId === userId)![1] as { title: string; body: string };
    // Lee is a recipient of both; Sam only of Priya's; Priya only of Sam's.
    expect(bodyFor('lee').title).toBe('2 plant tasks are up for grabs');
    expect(bodyFor('lee').body).toContain('Monstera');
    expect(bodyFor('lee').body).toContain('Fern');
    expect(bodyFor('sam').body).not.toContain('Monstera');
    expect(bodyFor('priya').body).not.toContain('Fern');
  });

  it('a failed send is logged, not retried, and the occurrence stays escalated (at-most-once)', async () => {
    await mockStore({ escalateAfterDays: 5, planId: 'garden' });
    await members();
    await allPrefs();
    const notifier = await import('../../../src/services/notifier.js');
    vi.mocked(notifier.sendToUser).mockRejectedValueOnce(new Error('ses down'));
    const { runEscalations } = await import('../../../src/services/escalation.js');
    expect(await runEscalations('hh', [task()], NOW)).toEqual({ escalated: 1, notified: 1 });
  });
});
