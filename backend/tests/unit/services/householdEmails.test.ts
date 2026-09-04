import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
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
  getMemberByUserId: vi.fn(),
  getHousehold: vi.fn(),
  listAllHouseholdIds: vi.fn(),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getTasksDueBy: vi.fn(),
  getTasks: vi.fn(),
}));
vi.mock('../../../src/services/plantService.js', () => ({
  getPlants: vi.fn(),
}));
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  isInDndWindow: vi.fn(() => false),
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const overdueBy = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const ALL_PREFS = {
  email: true,
  memberJoined: true,
  taskUpForGrabs: true,
  coverageUpdates: true,
  careCredit: true,
  timezone: 'UTC',
};

const memberA = {
  householdId: 'hh',
  userId: 'u1',
  name: 'Sam',
  email: 'sam@x.com',
  role: 'admin' as const,
  joinedAt: '',
};
const memberB = {
  householdId: 'hh',
  userId: 'u2',
  name: 'Alex',
  email: 'alex@x.com',
  role: 'member' as const,
  joinedAt: '',
};
const memberC = {
  householdId: 'hh',
  userId: 'u3',
  name: 'Priya',
  email: 'priya@x.com',
  role: 'member' as const,
  joinedAt: '',
};

function conditionalFailure(): Error {
  const err = new Error('conditional');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

async function mockPrefs(byUser: Record<string, Record<string, unknown>> = {}) {
  const prefs = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(prefs.getPreferences).mockImplementation(
    async (userId: string) => ({ userId, ...ALL_PREFS, ...byUser[userId] }) as never
  );
}

async function mockRoster(members = [memberA, memberB]) {
  const householdService = await import('../../../src/services/householdService.js');
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue(members as never);
  vi.mocked(householdService.getMemberByUserId).mockImplementation(
    async (_hh: string, userId: string) =>
      (members.find((m) => m.userId === userId) ?? null) as never
  );
  vi.mocked(householdService.getHousehold).mockResolvedValue({
    id: 'hh',
    name: 'The Kim House',
    createdAt: '',
    createdBy: 'u1',
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://app.example.net';
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockResolvedValue({} as never);
  const emailNotifier = await import('../../../src/services/emailNotifier.js');
  vi.mocked(emailNotifier.sendEmail).mockResolvedValue(true);
  const prefsModule = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(prefsModule.isInDndWindow).mockReturnValue(false);
  await mockPrefs();
  await mockRoster();
});

// ---------------------------------------------------------------------------
// 2. Someone joined
// ---------------------------------------------------------------------------

describe('notifyMemberJoined', () => {
  it('queues one email for every existing member and none for the joiner', async () => {
    await mockRoster([memberA, memberB, memberC]);
    const { notifyMemberJoined } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    const queued = await notifyMemberJoined(
      { householdId: 'hh', joinedUserId: 'u3', invitedBy: 'u1' },
      NOW
    );

    expect(queued).toBe(2);
    const keys = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => (call[0] as { input: { Key?: { PK: string } } }).input.Key?.PK)
      .filter(Boolean);
    expect(keys).toContain('USER#u1');
    expect(keys).toContain('USER#u2');
    expect(keys).not.toContain('USER#u3');
  });

  it('marks the invite sender so only they are thanked for inviting', async () => {
    await mockRoster([memberA, memberB]);
    const { notifyMemberJoined } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await notifyMemberJoined({ householdId: 'hh', joinedUserId: 'u3', invitedBy: 'u1' }, NOW);

    const payloads = vi.mocked(dynamodb.send).mock.calls.map((call) => {
      const input = (call[0] as { input: Record<string, never> }).input as unknown as {
        Key?: { PK: string };
        ExpressionAttributeValues?: { ':one'?: string[] };
      };
      return {
        pk: input.Key?.PK,
        item: JSON.parse(input.ExpressionAttributeValues?.[':one']?.[0] ?? '{}'),
      };
    });
    expect(payloads.find((p) => p.pk === 'USER#u1')?.item.invitedByRecipient).toBe(true);
    expect(payloads.find((p) => p.pk === 'USER#u2')?.item.invitedByRecipient).toBe(false);
  });

  it('records a null name rather than a stand-in when the member row cannot be read', async () => {
    await mockRoster([memberA]);
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMemberByUserId).mockRejectedValue(new Error('ddb down'));
    const { notifyMemberJoined } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await notifyMemberJoined({ householdId: 'hh', joinedUserId: 'u3', invitedBy: 'u1' }, NOW);

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: { ':one': string[] } };
    };
    const item = JSON.parse(call.input.ExpressionAttributeValues[':one'][0]);
    expect(item.memberName).toBeNull();
  });

  it('skips a member who turned this email off', async () => {
    await mockRoster([memberA, memberB]);
    await mockPrefs({ u2: { memberJoined: false } });
    const { notifyMemberJoined } = await import('../../../src/services/householdEmails.js');
    expect(
      await notifyMemberJoined({ householdId: 'hh', joinedUserId: 'u3', invitedBy: 'u1' }, NOW)
    ).toBe(1);
  });

  it('skips a member who turned email off entirely', async () => {
    await mockRoster([memberA, memberB]);
    await mockPrefs({ u1: { email: false }, u2: { email: false } });
    const { notifyMemberJoined } = await import('../../../src/services/householdEmails.js');
    expect(
      await notifyMemberJoined({ householdId: 'hh', joinedUserId: 'u3', invitedBy: 'u1' }, NOW)
    ).toBe(0);
  });

  it('does not queue a second copy for the same join', async () => {
    await mockRoster([memberA]);
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValue(conditionalFailure());
    const { notifyMemberJoined } = await import('../../../src/services/householdEmails.js');
    expect(
      await notifyMemberJoined({ householdId: 'hh', joinedUserId: 'u3', invitedBy: 'u1' }, NOW)
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Up for grabs
// ---------------------------------------------------------------------------

const unassignedTask = {
  id: 't1',
  householdId: 'hh',
  plantId: 'p1',
  plantName: 'Monstera',
  type: 'water' as const,
  customType: null,
  frequency: 7,
  lastCompleted: null,
  nextDue: overdueBy(4),
  assignedTo: null,
  assignedToName: null,
  assignmentSource: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

describe('upForGrabsHousehold', () => {
  it('offers a long-overdue unassigned task to the whole household', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([unassignedTask] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([{ id: 'p1', name: 'Monstera' }] as never);
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(await upForGrabsHousehold('hh', NOW)).toBe('queued');
    const pks = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => (c[0] as { input: { Key?: { PK: string } } }).input.Key?.PK);
    expect(pks).toEqual(['USER#u1', 'USER#u2']);
  });

  it('only looks at tasks already overdue by the grace period', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([] as never);
    const { upForGrabsHousehold, UP_FOR_GRABS_MIN_DAYS_OVERDUE } =
      await import('../../../src/services/householdEmails.js');

    await upForGrabsHousehold('hh', NOW);

    const cutoff = vi.mocked(taskService.getTasksDueBy).mock.calls[0][1];
    expect(Date.parse(cutoff)).toBe(NOW.getTime() - UP_FOR_GRABS_MIN_DAYS_OVERDUE * DAY);
  });

  it('ignores tasks that already have an assignee', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([
      { ...unassignedTask, assignedTo: 'u2', assignedToName: 'Alex' },
    ] as never);
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    expect(await upForGrabsHousehold('hh', NOW)).toBe('none');
  });

  it('reports "unknown" — not "none" — when the active-plant read comes back empty', async () => {
    // The digest's computePlantsAtRisk treats this as a healthy household and
    // sends nothing, which the product's help copy teaches users to read as
    // good news. This keeps the two apart.
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([unassignedTask] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([] as never);
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(await upForGrabsHousehold('hh', NOW)).toBe('unknown');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('reports "none" when every overdue task belongs to a plant that is gone', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([unassignedTask] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([{ id: 'other', name: 'Pothos' }] as never);
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    expect(await upForGrabsHousehold('hh', NOW)).toBe('none');
  });

  it('states the real total while listing at most five', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...unassignedTask,
      id: `t${i}`,
      plantId: `p${i}`,
      nextDue: overdueBy(9 - i),
    }));
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue(many as never);
    vi.mocked(plantService.getPlants).mockResolvedValue(
      many.map((t) => ({ id: t.plantId, name: t.plantName })) as never
    );
    await mockRoster([memberA]);
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await upForGrabsHousehold('hh', NOW);

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: { ':one': string[] } };
    };
    const item = JSON.parse(call.input.ExpressionAttributeValues[':one'][0]);
    expect(item.totalCount).toBe(9);
    expect(item.tasks).toHaveLength(5);
    // Longest-waiting first.
    expect(item.tasks[0].nextDue).toBe(overdueBy(9));
  });

  it('keys the daily marker on the recipient local date, not the server date', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([unassignedTask] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([{ id: 'p1', name: 'Monstera' }] as never);
    await mockRoster([memberA]);
    // 12:00 UTC on the 3rd is already the 4th at UTC+14.
    await mockPrefs({ u1: { timezone: 'Pacific/Kiritimati' } });
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await upForGrabsHousehold('hh', NOW);

    const sk = (vi.mocked(dynamodb.send).mock.calls[0][0] as { input: { Key: { SK: string } } })
      .input.Key.SK;
    expect(sk).toBe('HHEMAIL#up_for_grabs#hh#2026-09-04');
  });

  it('skips members who turned the up-for-grabs email off', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([unassignedTask] as never);
    vi.mocked(plantService.getPlants).mockResolvedValue([{ id: 'p1', name: 'Monstera' }] as never);
    await mockPrefs({ u1: { taskUpForGrabs: false }, u2: { taskUpForGrabs: false } });
    const { upForGrabsHousehold } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(await upForGrabsHousehold('hh', NOW)).toBe('none');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Coverage
// ---------------------------------------------------------------------------

describe('notifyCoverageAssigned', () => {
  const window = {
    householdId: 'hh',
    awayUserId: 'u1',
    coveredBy: 'u2',
    startDate: '2026-09-05T00:00:00.000Z',
    endDate: '2026-09-12T00:00:00.000Z',
  };

  it('queues the cover a heads-up with the away member and the task list', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasks).mockResolvedValue([
      { ...unassignedTask, assignedTo: 'u1', nextDue: '2026-09-07T00:00:00.000Z' },
    ] as never);
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(await notifyCoverageAssigned(window, NOW)).toBe('queued');

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Key: { PK: string; SK: string }; ExpressionAttributeValues: { ':one': string[] } };
    };
    expect(call.input.Key.PK).toBe('USER#u2');
    expect(call.input.Key.SK).toBe(
      'HHEMAIL#coverage#hh#u1#2026-09-05T00:00:00.000Z#2026-09-12T00:00:00.000Z'
    );
    const item = JSON.parse(call.input.ExpressionAttributeValues[':one'][0]);
    expect(item.awayName).toBe('Sam');
    expect(item.tasks).toHaveLength(1);
  });

  it('records null tasks — not an empty list — when the task read fails', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasks).mockRejectedValue(new Error('ddb down'));
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(await notifyCoverageAssigned(window, NOW)).toBe('queued');

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: { ':one': string[] } };
    };
    expect(JSON.parse(call.input.ExpressionAttributeValues[':one'][0]).tasks).toBeNull();
  });

  it('records an empty list when the read settled and there is genuinely nothing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasks).mockResolvedValue([] as never);
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await notifyCoverageAssigned(window, NOW);

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: { ':one': string[] } };
    };
    expect(JSON.parse(call.input.ExpressionAttributeValues[':one'][0]).tasks).toEqual([]);
  });

  it('drops tasks that fall after the window closes', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasks).mockResolvedValue([
      { ...unassignedTask, assignedTo: 'u1', nextDue: '2026-09-07T00:00:00.000Z' },
      { ...unassignedTask, id: 't2', assignedTo: 'u1', nextDue: '2026-10-01T00:00:00.000Z' },
    ] as never);
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await notifyCoverageAssigned(window, NOW);

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: { ':one': string[] } };
    };
    expect(JSON.parse(call.input.ExpressionAttributeValues[':one'][0]).tasks).toHaveLength(1);
  });

  it('sends nothing when the cover turned coverage emails off', async () => {
    await mockPrefs({ u2: { coverageUpdates: false } });
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    expect(await notifyCoverageAssigned(window, NOW)).toBe('ineligible');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the cover is not a resolvable member', async () => {
    await mockRoster([memberA]);
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    expect(await notifyCoverageAssigned(window, NOW)).toBe('ineligible');
  });

  it('does not re-send when the same window is saved twice', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasks).mockResolvedValue([] as never);
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValue(conditionalFailure());
    const { notifyCoverageAssigned } = await import('../../../src/services/householdEmails.js');
    expect(await notifyCoverageAssigned(window, NOW)).toBe('duplicate');
  });
});

// ---------------------------------------------------------------------------
// 5. Care credit
// ---------------------------------------------------------------------------

describe('notifyCoveredCompletion', () => {
  const assignedTask = {
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water' as const,
    customType: null,
    assignedTo: 'u1',
  };

  it('credits the helper to the person whose task it was', async () => {
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    expect(
      await notifyCoveredCompletion(
        { householdId: 'hh', task: assignedTask, completedBy: 'u2', notes: 'soil was dry' },
        NOW
      )
    ).toBe('queued');

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Key: { PK: string; SK: string }; ExpressionAttributeValues: { ':one': string[] } };
    };
    expect(call.input.Key.PK).toBe('USER#u1');
    expect(call.input.Key.SK).toBe('HHEMAIL#care_credit#hh#2026-09-03');
    const item = JSON.parse(call.input.ExpressionAttributeValues[':one'][0]);
    expect(item.actorName).toBe('Alex');
    expect(item.note).toBe('soil was dry');
  });

  it('does nothing when you complete your own task', async () => {
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    expect(
      await notifyCoveredCompletion(
        { householdId: 'hh', task: assignedTask, completedBy: 'u1' },
        NOW
      )
    ).toBe('ineligible');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('does nothing for an unassigned task — there is nobody to thank on behalf of', async () => {
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    expect(
      await notifyCoveredCompletion(
        { householdId: 'hh', task: { ...assignedTask, assignedTo: null }, completedBy: 'u2' },
        NOW
      )
    ).toBe('ineligible');
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('respects the careCredit toggle', async () => {
    await mockPrefs({ u1: { careCredit: false } });
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');
    expect(
      await notifyCoveredCompletion(
        { householdId: 'hh', task: assignedTask, completedBy: 'u2' },
        NOW
      )
    ).toBe('ineligible');
  });

  it('records a null actor rather than inventing one when the member read fails', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMemberByUserId).mockImplementation(
      async (_hh: string, userId: string) => {
        if (userId === 'u2') throw new Error('ddb down');
        return memberA as never;
      }
    );
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await notifyCoveredCompletion(
      { householdId: 'hh', task: assignedTask, completedBy: 'u2' },
      NOW
    );

    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: { ':one': string[] } };
    };
    expect(JSON.parse(call.input.ExpressionAttributeValues[':one'][0]).actorName).toBeNull();
  });

  it('rolls a second covered task into the same day, and counts the rest as overflow', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // First write is the roll-up append (rejected: row is full), second is the
    // overflow counter.
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({} as never);
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');

    expect(
      await notifyCoveredCompletion(
        { householdId: 'hh', task: assignedTask, completedBy: 'u2' },
        NOW
      )
    ).toBe('counted');

    const overflowCall = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { UpdateExpression: string };
    };
    expect(overflowCall.input.UpdateExpression).toContain('ADD overflow');
  });

  it('does not reopen a row that was already delivered today', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValue(conditionalFailure());
    const { notifyCoveredCompletion } = await import('../../../src/services/householdEmails.js');
    expect(
      await notifyCoveredCompletion(
        { householdId: 'hh', task: assignedTask, completedBy: 'u2' },
        NOW
      )
    ).toBe('duplicate');
  });
});

// ---------------------------------------------------------------------------
// Rendering + flush
// ---------------------------------------------------------------------------

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: 'USER#u1',
    SK: 'HHEMAIL#member_joined#hh#u3',
    kind: 'member_joined',
    householdId: 'hh',
    email: 'sam@x.com',
    status: 'pending',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + DAY).toISOString(),
    items: [
      JSON.stringify({
        memberName: 'Priya',
        householdName: 'The Kim House',
        invitedByRecipient: true,
        householdUrl: 'https://app.example.net/household',
      }),
    ],
    ...overrides,
  };
}

async function mockQueue(rows: Array<Record<string, unknown>>) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockImplementation(async (command: unknown) => {
    if ((command as { kind?: string }).kind === 'Query') return { Items: rows } as never;
    return {} as never;
  });
}

describe('renderQueued', () => {
  it('renders each kind in the recipient language', async () => {
    const { renderQueued } = await import('../../../src/services/householdEmails.js');
    const en = renderQueued(pendingRow() as never, 'en', NOW);
    expect(en?.subject).toBe('Priya joined The Kim House');
    const es = renderQueued(pendingRow() as never, 'es', NOW);
    expect(es?.subject).toBe('Priya se ha unido a The Kim House');
  });

  it('returns null rather than an empty email when nothing parses', async () => {
    const { renderQueued } = await import('../../../src/services/householdEmails.js');
    expect(renderQueued(pendingRow({ items: ['{oops'] }) as never, 'en', NOW)).toBeNull();
  });

  it('links up-for-grabs lines to the exact plant', async () => {
    const { renderQueued } = await import('../../../src/services/householdEmails.js');
    const composed = renderQueued(
      pendingRow({
        kind: 'up_for_grabs',
        items: [
          JSON.stringify({
            householdName: 'The Kim House',
            totalCount: 1,
            tasks: [
              {
                plantId: 'p1',
                plantName: 'Monstera',
                type: 'water',
                customType: null,
                nextDue: overdueBy(4),
              },
            ],
          }),
        ],
      }) as never,
      'en',
      NOW
    );
    expect(composed?.text).toContain('https://app.example.net/plants/p1');
    expect(composed?.text).toContain('4 days overdue');
  });
});

describe('flushUser', () => {
  it('sends a pending row and marks it sent', async () => {
    await mockQueue([pendingRow()]);
    const { flushUser } = await import('../../../src/services/householdEmails.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    const summary = await flushUser('u1', NOW);

    expect(summary.sent).toBe(1);
    expect(emailNotifier.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sam@x.com', subject: 'Priya joined The Kim House' })
    );
  });

  it('holds a row during the recipient quiet hours instead of dropping it', async () => {
    await mockQueue([pendingRow()]);
    const prefs = await import('../../../src/services/notificationPrefs.js');
    vi.mocked(prefs.isInDndWindow).mockReturnValue(true);
    const { flushUser } = await import('../../../src/services/householdEmails.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    const summary = await flushUser('u1', NOW);

    expect(summary).toMatchObject({ sent: 0, deferred: 1, expired: 0, failed: 0 });
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('re-reads preferences at send time so a late opt-out still wins', async () => {
    await mockQueue([pendingRow()]);
    await mockPrefs({ u1: { memberJoined: false } });
    const { flushUser } = await import('../../../src/services/householdEmails.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    const summary = await flushUser('u1', NOW);

    expect(summary.suppressed).toBe(1);
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('drops a stale row rather than sending yesterday news, and says so', async () => {
    await mockQueue([pendingRow({ expiresAt: new Date(NOW.getTime() - DAY).toISOString() })]);
    const { flushUser } = await import('../../../src/services/householdEmails.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    const summary = await flushUser('u1', NOW);

    expect(summary).toMatchObject({ expired: 1, sent: 0 });
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('treats a dry run as a failure, not a delivery, and leaves the row pending', async () => {
    await mockQueue([pendingRow()]);
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail).mockResolvedValue(false);
    const { flushUser } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    const summary = await flushUser('u1', NOW);

    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    const wrote = vi
      .mocked(dynamodb.send)
      .mock.calls.some((c) => (c[0] as { kind?: string }).kind !== 'Query');
    expect(wrote).toBe(false);
  });

  it('keeps a provider exception from taking out the rest of the queue', async () => {
    await mockQueue([
      pendingRow(),
      pendingRow({ SK: 'HHEMAIL#member_joined#hh#u4', kind: 'member_joined' }),
    ]);
    const emailNotifier = await import('../../../src/services/emailNotifier.js');
    vi.mocked(emailNotifier.sendEmail)
      .mockRejectedValueOnce(new Error('ses down'))
      .mockResolvedValueOnce(true);
    const { flushUser } = await import('../../../src/services/householdEmails.js');

    const summary = await flushUser('u1', NOW);

    expect(summary).toMatchObject({ sent: 1, failed: 1 });
  });

  it('ignores rows already delivered', async () => {
    await mockQueue([pendingRow({ status: 'sent' })]);
    const { flushUser } = await import('../../../src/services/householdEmails.js');
    const emailNotifier = await import('../../../src/services/emailNotifier.js');

    expect(await flushUser('u1', NOW)).toMatchObject({ sent: 0 });
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The hourly pass
// ---------------------------------------------------------------------------

describe('runHouseholdEmails', () => {
  it('counts an unsettled household apart from a quiet one', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh', 'hh2'] as never);
    vi.mocked(taskService.getTasksDueBy).mockImplementation(
      async (householdId: string) => (householdId === 'hh' ? [unassignedTask] : []) as never
    );
    vi.mocked(plantService.getPlants).mockResolvedValue([] as never);
    await mockQueue([]);
    const { runHouseholdEmails } = await import('../../../src/services/householdEmails.js');

    const summary = await runHouseholdEmails(NOW);

    expect(summary).toMatchObject({ households: 2, offered: 0, unknown: 1, failed: 0 });
  });

  it('keeps one broken household from aborting the pass', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['bad', 'hh'] as never);
    vi.mocked(taskService.getTasksDueBy).mockImplementation(async (householdId: string) => {
      if (householdId === 'bad') throw new Error('ddb down');
      return [] as never;
    });
    await mockQueue([]);
    const { runHouseholdEmails } = await import('../../../src/services/householdEmails.js');

    const summary = await runHouseholdEmails(NOW);

    expect(summary.households).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('flushes a multi-household member exactly once per pass', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(householdService.listAllHouseholdIds).mockResolvedValue(['hh', 'hh2'] as never);
    vi.mocked(taskService.getTasksDueBy).mockResolvedValue([] as never);
    await mockQueue([]);
    const { runHouseholdEmails } = await import('../../../src/services/householdEmails.js');
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');

    await runHouseholdEmails(NOW);

    const queries = vi
      .mocked(dynamodb.send)
      .mock.calls.filter((c) => (c[0] as { kind?: string }).kind === 'Query');
    expect(queries).toHaveLength(2); // u1 and u2, once each across both households
  });
});
