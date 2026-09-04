/**
 * "Ask family to do it" (ADR 0024) — the I/O half: the refusals, the
 * DynamoDB-enforced daily limit, the conditional write that reaches the SAME
 * escalated state auto-handoff uses, the guarded fan-out, and the honest
 * "nobody could be reached" outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import type { NotificationPreferences } from '../../../src/services/notificationPrefs.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
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
  getTask: vi.fn(),
  listVacationWindows: vi.fn(async () => []),
  itemToTask: vi.fn((item: Record<string, unknown>) => item as unknown as Task),
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

const NOW = new Date('2026-09-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DUE = '2026-09-06T08:00:00.000Z';

const sam = {
  householdId: 'hh',
  userId: 'sam',
  name: 'Sam',
  email: 'sam@x.com',
  role: 'member' as const,
  joinedAt: '2026-01-01',
};
const priya = {
  ...sam,
  userId: 'priya',
  name: 'Priya',
  email: 'priya@x.com',
  joinedAt: '2026-02-01',
};
const lee = { ...sam, userId: 'lee', name: 'Lee', email: 'lee@x.com', joinedAt: '2026-03-01' };

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
    memberJoined: true,
    taskUpForGrabs: true,
    coverageUpdates: true,
    careCredit: true,
    yearRecap: true,
    emailLocale: '',
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
    nextDue: DUE,
    assignedTo: 'sam',
    assignedToName: 'Sam',
    assignmentSource: null,
    notes: null,
    createdBy: 'sam',
    createdAt: '',
    ...overrides,
  };
}

async function setup({
  current = task(),
  members = [sam, priya, lee],
  vacations = [] as Array<Record<string, unknown>>,
  prefsByUser = {} as Record<string, Partial<NotificationPreferences>>,
} = {}) {
  const householdService = await import('../../../src/services/householdService.js');
  const taskService = await import('../../../src/services/taskService.js');
  const notificationPrefs = await import('../../../src/services/notificationPrefs.js');
  const notifier = await import('../../../src/services/notifier.js');
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');

  vi.mocked(taskService.getTask).mockResolvedValue(current);
  vi.mocked(taskService.listVacationWindows).mockResolvedValue(vacations as never);
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue(members);
  vi.mocked(notificationPrefs.getPreferences).mockImplementation(async (userId: string) =>
    prefs(userId, prefsByUser[userId] ?? {})
  );
  // Put (slot claim) then Update (the task write) both succeed by default.
  vi.mocked(dynamodb.send).mockImplementation((async (command: { kind: string }) =>
    command.kind === 'Update'
      ? { Attributes: { ...current, assignedTo: null, assignedToName: null, helpAskedForDue: DUE } }
      : {}) as never);
  return { householdService, taskService, notificationPrefs, notifier, dynamodb };
}

function ask(overrides: Record<string, unknown> = {}) {
  return {
    householdId: 'hh',
    taskId: 't1',
    asker: { userId: 'sam', email: 'sam@x.com' },
    now: NOW,
    ...overrides,
  };
}

const commands = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(([c]) => c as unknown as { kind: string; input: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('askFamilyForHelp — refusals', () => {
  it('404s a task that is not there, without writing anything', async () => {
    const { dynamodb } = await setup();
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTask).mockResolvedValue(null);
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).rejects.toMatchObject({ name: 'TaskNotFoundError' });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('refuses to give away another member’s EXPLICIT claim', async () => {
    const { dynamodb } = await setup({
      current: task({ assignedTo: 'priya', assignedToName: 'Priya', assignmentSource: null }),
    });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).rejects.toMatchObject({
      name: 'TaskHeldByAnotherMemberError',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('allows asking about an INHERITED assignment held by someone else', async () => {
    // Same line claimTask draws: a space default / rotation turn is a
    // suggestion anyone may take over, so anyone may ask about it too.
    await setup({
      current: task({ assignedTo: 'priya', assignedToName: 'Priya', assignmentSource: 'rotation' }),
    });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).resolves.toMatchObject({ delivered: 2 });
  });

  it('refuses a second ask about the same occurrence', async () => {
    const { dynamodb } = await setup({ current: task({ helpAskedForDue: DUE }) });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).rejects.toMatchObject({
      name: 'HelpAlreadyRequestedError',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('refuses when the caller is pinning an occurrence that has already moved', async () => {
    const { dynamodb } = await setup();
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(
      askFamilyForHelp(ask({ expectedNextDue: '2026-08-30T08:00:00.000Z' }))
    ).rejects.toMatchObject({ name: 'TaskChangedError' });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });
});

describe('askFamilyForHelp — one ask per task per member per 24h', () => {
  it('claims the slot with a conditional Put keyed by task + member, with a TTL', async () => {
    const { dynamodb } = await setup();
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    const result = await askFamilyForHelp(ask());

    const put = commands(vi.mocked(dynamodb.send)).find((c) => c.kind === 'Put')!;
    const item = put.input.Item as Record<string, unknown>;
    expect(item.PK).toBe('HOUSEHOLD#hh');
    expect(item.SK).toBe('TASK_HELP_ASK#t1#sam');
    expect(item.askedAtEpoch).toBe(Math.floor(NOW.getTime() / 1000));
    expect(item.ttl).toBeGreaterThan(Math.floor((NOW.getTime() + DAY_MS) / 1000));
    expect(put.input.ConditionExpression).toBe(
      'attribute_not_exists(PK) OR askedAtEpoch < :cutoff'
    );
    expect(put.input.ExpressionAttributeValues).toEqual({
      ':cutoff': Math.floor((NOW.getTime() - DAY_MS) / 1000),
    });
    expect(result.nextAllowedAt).toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
  });

  it('refuses a repeat inside the window, sends nothing, and says when to ask again', async () => {
    const { dynamodb, notifier } = await setup();
    const earlierEpoch = Math.floor((NOW.getTime() - 3 * 60 * 60 * 1000) / 1000);
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(
        Object.assign(new Error('conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      )
      .mockResolvedValueOnce({ Item: { askedAtEpoch: earlierEpoch } } as never);
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    await expect(askFamilyForHelp(ask())).rejects.toMatchObject({
      name: 'AskHelpRateLimitedError',
      nextAllowedAt: new Date(earlierEpoch * 1000 + DAY_MS).toISOString(),
    });
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });

  it('reports a NULL nextAllowedAt rather than guessing one when the marker cannot be read', async () => {
    const { dynamodb } = await setup();
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(
        Object.assign(new Error('conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      )
      .mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    await expect(askFamilyForHelp(ask())).rejects.toMatchObject({
      name: 'AskHelpRateLimitedError',
      nextAllowedAt: null,
    });
  });

  it('hands the slot back when the task write loses the race', async () => {
    const { dynamodb, notifier } = await setup();
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(dynamodb.send).mockImplementation((async (command: { kind: string }) => {
      if (command.kind === 'Update') {
        throw Object.assign(new Error('conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return {};
    }) as never);
    // The re-read explains WHICH of the pinned things moved.
    vi.mocked(taskService.getTask)
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ helpAskedForDue: DUE, assignedTo: null }));
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    await expect(askFamilyForHelp(ask())).rejects.toMatchObject({
      name: 'HelpAlreadyRequestedError',
    });
    // A member beaten to it by a housemate must not also lose their turn.
    const del = commands(vi.mocked(dynamodb.send)).find((c) => c.kind === 'Delete')!;
    expect(del.input.Key).toEqual({ PK: 'HOUSEHOLD#hh', SK: 'TASK_HELP_ASK#t1#sam' });
    expect(del.input.ConditionExpression).toBe('askedAtEpoch = :epoch');
    expect(notifier.sendToUser).not.toHaveBeenCalled();
  });
});

describe('askFamilyForHelp — the write reaches the escalated state', () => {
  it('pins the occurrence, records the asker and the note, and clears the holder', async () => {
    const { dynamodb } = await setup();
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    await askFamilyForHelp(ask({ note: '  I am  travelling until Sunday ' }));

    const update = commands(vi.mocked(dynamodb.send)).find((c) => c.kind === 'Update')!;
    const values = update.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(update.input.Key).toEqual({ PK: 'HOUSEHOLD#hh', SK: 'TASK#t1' });
    expect(values[':due']).toBe(DUE);
    expect(values[':note']).toBe('I am travelling until Sunday');
    expect(values[':asker']).toBe('sam');
    expect(values[':from']).toBe('sam');
    // The SAME escalated slot auto-handoff uses — not a parallel state.
    expect(update.input.UpdateExpression).toContain('#escalatedForDue = :due');
    expect(update.input.UpdateExpression).toContain('#assignedTo = :null');
    expect(update.input.UpdateExpression).toContain('REMOVE GSI2PK, GSI2SK');
    // Once per occurrence, and the holder we read is pinned so no concurrent
    // claim gets stripped.
    expect(update.input.ConditionExpression).toContain('#nextDue = :due');
    expect(update.input.ConditionExpression).toContain('#helpAskedForDue <> :due');
    expect(update.input.ConditionExpression).toContain('#assignedTo = :holder');
    expect(values[':holder']).toBe('sam');
  });

  it('preserves an earlier auto-handoff’s previous holder rather than nulling it', async () => {
    const { dynamodb } = await setup({
      current: task({ assignedTo: null, assignedToName: null, escalatedFrom: 'priya' }),
    });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await askFamilyForHelp(ask());
    const update = commands(vi.mocked(dynamodb.send)).find((c) => c.kind === 'Update')!;
    const values = update.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':from']).toBe('priya');
    expect(update.input.ConditionExpression).toContain('attribute_not_exists(#assignedTo)');
  });

  it('records a task.help_requested activity row carrying the note and the reach', async () => {
    await setup();
    const { recordActivity } = await import('../../../src/services/activity.js');
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await askFamilyForHelp(ask({ note: 'away all week' }));
    expect(recordActivity).toHaveBeenCalledWith({
      type: 'task.help_requested',
      householdId: 'hh',
      actorId: 'sam',
      actorName: 'Sam',
      payload: {
        taskId: 't1',
        plantId: 'p1',
        plantName: 'Monstera',
        taskType: 'water',
        note: 'away all week',
        notified: 2,
      },
    });
  });
});

describe('askFamilyForHelp — who hears about it', () => {
  it('tells every other member, never the asker, and returns names not emails', async () => {
    const { notifier } = await setup();
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    const result = await askFamilyForHelp(ask({ note: 'travelling' }));

    expect(result.recipients).toEqual([
      { userId: 'priya', name: 'Priya' },
      { userId: 'lee', name: 'Lee' },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.delivered).toBe(2);
    expect(JSON.stringify(result.recipients)).not.toContain('@x.com');
    const told = vi.mocked(notifier.sendToUser).mock.calls.map(([r]) => r.userId);
    expect(told.sort()).toEqual(['lee', 'priya']);
    const [, payload] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect(payload.title).toBe('Sam is asking for a hand');
    expect(payload.body).toContain('Sam says: “travelling”');
    expect(payload.shortBody).toBe('Water for Monstera is up for grabs.');
    expect(payload.tag).toBe(`ask-family:hh:t1:${DUE}`);
  });

  it('leaves out anyone away or inside Do-Not-Disturb, and SAYS SO', async () => {
    const { notifier } = await setup({
      vacations: [
        {
          userId: 'priya',
          coveredBy: 'lee',
          coveredByName: 'Lee',
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: '2026-09-30T00:00:00.000Z',
        },
      ],
      prefsByUser: { lee: { dndStart: '11:00', dndEnd: '14:00' } },
    });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');

    const result = await askFamilyForHelp(ask());

    expect(result.recipients).toEqual([]);
    expect(result.skipped).toEqual([
      { userId: 'priya', name: 'Priya', reason: 'away' },
      { userId: 'lee', name: 'Lee', reason: 'dnd' },
    ]);
    // Nobody reachable is a REAL outcome — the occurrence still went up for
    // grabs, and nothing was sent.
    expect(result.delivered).toBe(0);
    expect(notifier.sendToUser).not.toHaveBeenCalled();
    expect(result.task.helpAskedForDue).toBe(DUE);
  });

  it('reports delivered:0 when the fan-out ran but nothing left the building', async () => {
    const { notifier } = await setup();
    vi.mocked(notifier.sendToUser).mockResolvedValue({
      delivered: false,
      dndSuppressedOnly: false,
      channels: { browser: 'failed', email: 'failed', sms: 'skipped' },
    });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    const result = await askFamilyForHelp(ask());
    expect(result.recipients).toHaveLength(2);
    expect(result.delivered).toBe(0);
  });

  it('does not fail the ask when one recipient’s send throws', async () => {
    const { notifier } = await setup();
    vi.mocked(notifier.sendToUser)
      .mockRejectedValueOnce(new Error('SES down'))
      .mockResolvedValueOnce({
        delivered: true,
        dndSuppressedOnly: false,
        channels: { browser: 'skipped', email: 'delivered', sms: 'skipped' },
      });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).resolves.toMatchObject({ delivered: 1 });
  });

  it('writes each recipient in their own language, falling back to the household’s', async () => {
    const { notifier } = await setup({
      prefsByUser: { priya: { emailLocale: 'es' }, lee: { emailLocale: '' } },
    });
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await askFamilyForHelp(ask());
    const byUser = new Map(
      vi.mocked(notifier.sendToUser).mock.calls.map(([r, payload]) => [r.userId, payload])
    );
    expect(byUser.get('priya')!.title).toBe('Sam pide ayuda');
    // Lee has chosen nothing; the household's prevailing language is Spanish,
    // so Lee is not silently mailed in English.
    expect(byUser.get('lee')!.title).toBe('Sam pide ayuda');
  });
});

describe('askFamilyForHelp — absence is not a value (ADR 0010)', () => {
  it('aborts, writing nothing, when the roster cannot be read', async () => {
    const { dynamodb, householdService } = await setup();
    vi.mocked(householdService.getHouseholdMembers).mockRejectedValue(new Error('DDB down'));
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    // A failed roster read must never become "nobody to notify" and then be
    // reported as a delivered ask.
    await expect(askFamilyForHelp(ask())).rejects.toThrow('DDB down');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('aborts, writing nothing, when a member’s notification preferences cannot be read', async () => {
    const { dynamodb, notificationPrefs } = await setup();
    vi.mocked(notificationPrefs.getPreferences).mockRejectedValue(new Error('prefs unavailable'));
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).rejects.toThrow('prefs unavailable');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('aborts, writing nothing, when the vacation windows cannot be read', async () => {
    const { dynamodb, taskService } = await setup();
    vi.mocked(taskService.listVacationWindows).mockRejectedValue(
      new Error('vacations unavailable')
    );
    const { askFamilyForHelp } = await import('../../../src/services/askFamily.js');
    await expect(askFamilyForHelp(ask())).rejects.toThrow('vacations unavailable');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });
});
