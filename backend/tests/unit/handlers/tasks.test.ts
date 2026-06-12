import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/plantService.js');
// Activity records are best-effort side writes; mocked so handlers don't
// touch the real DDB client.
vi.mock('../../../src/services/activity.js', () => ({
  recordActivity: vi.fn(),
}));
// authMiddleware validates the claim household against the membership row;
// without this mock the handler tests would hit the real DDB client.
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(async () => ({
    householdId: 'hh-1',
    userId: 'user-1',
    name: 'Tester',
    email: 'a@b.com',
    role: 'admin',
    joinedAt: '',
  })),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const fakeContext = {} as Context;

describe('tasks handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listTasks parses query string filters', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { listTasks } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);

    const event = buildEvent({
      queryStringParameters: { plantId: 'p1', dueWithin: '14', overdue: 'true' },
    });
    const res = (await listTasks(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.getTasks).toHaveBeenCalledWith('hh-1', {
      plantId: 'p1',
      dueWithin: 14,
      overdue: true,
    });
  });

  it('listTasks 400s on non-numeric dueWithin instead of silently returning nothing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { listTasks } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await listTasks(
      buildEvent({ queryStringParameters: { dueWithin: 'soon' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(taskService.getTasks).not.toHaveBeenCalled();
  });

  it('getUpcomingTasks queries 7-day window', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { getUpcomingTasks } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.getUpcomingTasks).mockResolvedValueOnce([]);
    const res = (await getUpcomingTasks(
      buildEvent(),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.getUpcomingTasks).toHaveBeenCalledWith('hh-1');
  });

  it('createTask 404s when plant not found', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { createTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        plantId: '11111111-1111-1111-1111-111111111111',
        type: 'water',
        frequency: 7,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('createTask creates task with plant name', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const taskService = await import('../../../src/services/taskService.js');
    const { createTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValueOnce({
      id: 'p1',
      householdId: 'hh-1',
      name: 'Pothos',
      species: null,
      location: null,
      imageUrl: null,
      notes: null,
      createdAt: '',
      createdBy: '',
      updatedAt: '',
    });
    vi.mocked(taskService.createTask).mockResolvedValueOnce({
      id: 't1',
      householdId: 'hh-1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: 'user-1',
      createdAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      body: JSON.stringify({
        plantId: '11111111-1111-1111-1111-111111111111',
        type: 'water',
        frequency: 7,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        plantId: '11111111-1111-1111-1111-111111111111',
        type: 'water',
        frequency: 7,
      }),
      'hh-1',
      'user-1',
      'Pothos'
    );
  });

  it('completeTask handles JSON-parsed body without re-parsing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.completeTask).mockResolvedValueOnce({
      id: 't1',
      householdId: 'hh-1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: '',
      nextDue: '',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    });
    // Regression: when Content-Type: application/json, the body parser middleware
    // turns event.body into an object. The handler used to call JSON.parse on
    // that object, throwing TypeError. Pass JSON content type to exercise that path.
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't1' },
      body: JSON.stringify({ notes: 'done' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await completeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.completeTask).toHaveBeenCalledWith('hh-1', 't1', 'user-1', 'a', 'done');
  });

  it('completeTask returns 404 when task missing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.completeTask).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 'missing' },
      // completeTask now validates the body via Zod (completeTaskSchema);
      // the frontend always sends `{}` (or `{ notes }`), never bare null.
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await completeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('updateTask returns 404 when missing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { updateTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.updateTask).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'PUT',
      pathParameters: { id: 't' },
      body: JSON.stringify({ frequency: 14 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await updateTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('snoozeTask 404s when missing', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.snoozeTask).mockResolvedValueOnce(null);
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 3 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('snoozeTask validates days bounds', async () => {
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 0 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('snoozeTask returns updated task on success', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.snoozeTask).mockResolvedValueOnce({
      id: 't',
      householdId: 'hh-1',
      plantId: 'p',
      plantName: 'P',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '2026-05-04',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 3 }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(taskService.snoozeTask).toHaveBeenCalledWith('hh-1', 't', 3);
  });

  it('snoozeTask records the reason in the activity feed entry', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const activity = await import('../../../src/services/activity.js');
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.snoozeTask).mockResolvedValueOnce({
      id: 't',
      householdId: 'hh-1',
      plantId: 'p',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '2026-06-18',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    });
    const event = buildEvent({
      httpMethod: 'POST',
      pathParameters: { id: 't' },
      body: JSON.stringify({ days: 7, reason: 'rain' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await snoozeTask(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.snoozed',
        householdId: 'hh-1',
        actorId: 'user-1',
        payload: expect.objectContaining({ taskId: 't', days: 7, reason: 'rain' }),
      })
    );
  });

  it('snoozeTask rejects an unknown reason', async () => {
    const { snoozeTask } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await snoozeTask(
      buildEvent({
        httpMethod: 'POST',
        pathParameters: { id: 't' },
        body: JSON.stringify({ days: 7, reason: 'felt-like-it' }),
        headers: { 'content-type': 'application/json' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  describe('claim / unclaim', () => {
    const claimedTask = {
      id: 't1',
      householdId: 'hh-1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water' as const,
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '',
      assignedTo: 'user-1',
      assignedToName: 'Tester',
      notes: null,
      createdBy: '',
      createdAt: '',
    };

    it('claimTask returns the claimed task', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { claimTask } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.claimTask).mockResolvedValueOnce(claimedTask);
      const res = (await claimTask(
        buildEvent({ httpMethod: 'POST', pathParameters: { id: 't1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(taskService.claimTask).toHaveBeenCalledWith('hh-1', 't1', 'user-1');
      expect(JSON.parse(res.body).assignedTo).toBe('user-1');
    });

    it('claimTask 409s when the race was lost', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { claimTask } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.claimTask).mockResolvedValueOnce('already_claimed');
      const res = (await claimTask(
        buildEvent({ httpMethod: 'POST', pathParameters: { id: 't1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe('Already claimed');
    });

    it('claimTask 404s when the task is gone', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { claimTask } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.claimTask).mockResolvedValueOnce(null);
      const res = (await claimTask(
        buildEvent({ httpMethod: 'POST', pathParameters: { id: 'x' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
    });

    it('unclaimTask 403s for a non-assignee', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { unclaimTask } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.unclaimTask).mockResolvedValueOnce('not_assignee');
      const res = (await unclaimTask(
        buildEvent({ httpMethod: 'POST', pathParameters: { id: 't1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(403);
    });

    it('unclaimTask returns the released task for the assignee', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { unclaimTask } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.unclaimTask).mockResolvedValueOnce({
        ...claimedTask,
        assignedTo: null,
        assignedToName: null,
      });
      const res = (await unclaimTask(
        buildEvent({ httpMethod: 'POST', pathParameters: { id: 't1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(taskService.unclaimTask).toHaveBeenCalledWith('hh-1', 't1', 'user-1');
    });
  });

  describe('vacation endpoints', () => {
    const COVER = '22222222-2222-2222-2222-222222222222';
    const OTHER = '33333333-3333-3333-3333-333333333333';
    const memberRow = (userId: string, role: 'admin' | 'member' = 'member') => ({
      householdId: 'hh-1',
      userId,
      name: userId === COVER ? 'Cover' : 'Someone',
      email: 'x@x.com',
      role,
      joinedAt: '',
    });

    /** Caller (user-1) is a member with `role`; COVER/OTHER exist unless excluded. */
    async function mockMembers(opts: { callerRole?: 'admin' | 'member'; missing?: string[] } = {}) {
      const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
      __resetMembershipCacheForTests();
      const householdService = await import('../../../src/services/householdService.js');
      vi.mocked(householdService.getMemberByUserId).mockImplementation(
        async (_hh: string, userId: string) => {
          if (opts.missing?.includes(userId)) return null;
          if (userId === 'user-1') return memberRow('user-1', opts.callerRole ?? 'admin');
          return memberRow(userId);
        }
      );
    }

    const vacationEvent = (body: Record<string, unknown>) =>
      buildEvent({
        httpMethod: 'PUT',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });

    const validDates = {
      startDate: '2026-07-01T00:00:00.000Z',
      endDate: '2026-07-10T00:00:00.000Z',
    };

    it('setVacation upserts a window for the caller by default', async () => {
      await mockMembers();
      const taskService = await import('../../../src/services/taskService.js');
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.setVacationWindow).mockResolvedValueOnce({
        householdId: 'hh-1',
        userId: 'user-1',
        coveredBy: COVER,
        coveredByName: 'Cover',
        ...validDates,
        createdBy: 'user-1',
        createdAt: '',
      });
      const res = (await setVacation(
        vacationEvent({ coveredBy: COVER, ...validDates }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(taskService.setVacationWindow).toHaveBeenCalledWith(
        'hh-1',
        expect.objectContaining({ userId: 'user-1', coveredBy: COVER, coveredByName: 'Cover' }),
        'user-1'
      );
    });

    it('rejects endDate before startDate (400)', async () => {
      await mockMembers();
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      const res = (await setVacation(
        vacationEvent({
          coveredBy: COVER,
          startDate: '2026-07-10T00:00:00.000Z',
          endDate: '2026-07-01T00:00:00.000Z',
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
    });

    it('rejects windows longer than 90 days (400)', async () => {
      await mockMembers();
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      const res = (await setVacation(
        vacationEvent({
          coveredBy: COVER,
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
    });

    it('rejects coveredBy === target member (400)', async () => {
      await mockMembers();
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      const res = (await setVacation(
        vacationEvent({ userId: OTHER, coveredBy: OTHER, ...validDates }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
    });

    it('rejects a coveredBy who is not a household member (400)', async () => {
      await mockMembers({ missing: [COVER] });
      const taskService = await import('../../../src/services/taskService.js');
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      const res = (await setVacation(
        vacationEvent({ coveredBy: COVER, ...validDates }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(taskService.setVacationWindow).not.toHaveBeenCalled();
    });

    it('non-admin cannot set vacation for someone else (403)', async () => {
      await mockMembers({ callerRole: 'member' });
      const taskService = await import('../../../src/services/taskService.js');
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      const res = (await setVacation(
        vacationEvent({ userId: OTHER, coveredBy: COVER, ...validDates }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(403);
      expect(taskService.setVacationWindow).not.toHaveBeenCalled();
    });

    it('admin CAN set vacation for someone else', async () => {
      await mockMembers({ callerRole: 'admin' });
      const taskService = await import('../../../src/services/taskService.js');
      const { setVacation } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.setVacationWindow).mockResolvedValueOnce({
        householdId: 'hh-1',
        userId: OTHER,
        coveredBy: COVER,
        coveredByName: 'Cover',
        ...validDates,
        createdBy: 'user-1',
        createdAt: '',
      });
      const res = (await setVacation(
        vacationEvent({ userId: OTHER, coveredBy: COVER, ...validDates }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(taskService.setVacationWindow).toHaveBeenCalledWith(
        'hh-1',
        expect.objectContaining({ userId: OTHER }),
        'user-1'
      );
    });

    it('deleteVacation: self OK (204), missing window 404, non-admin × other 403', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { deleteVacation } = await import('../../../src/handlers/tasks/handler.js');

      await mockMembers({ callerRole: 'member' });
      vi.mocked(taskService.deleteVacationWindow).mockResolvedValueOnce(true);
      const self = (await deleteVacation(
        buildEvent({ httpMethod: 'DELETE', pathParameters: { userId: 'user-1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(self.statusCode).toBe(204);

      await mockMembers({ callerRole: 'member' });
      vi.mocked(taskService.deleteVacationWindow).mockResolvedValueOnce(false);
      const missing = (await deleteVacation(
        buildEvent({ httpMethod: 'DELETE', pathParameters: { userId: 'user-1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(missing.statusCode).toBe(404);

      await mockMembers({ callerRole: 'member' });
      const forbidden = (await deleteVacation(
        buildEvent({ httpMethod: 'DELETE', pathParameters: { userId: OTHER } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(forbidden.statusCode).toBe(403);
    });

    it('listVacations returns the household windows', async () => {
      await mockMembers();
      const taskService = await import('../../../src/services/taskService.js');
      const { listVacations } = await import('../../../src/handlers/tasks/handler.js');
      vi.mocked(taskService.listVacationWindows).mockResolvedValueOnce([
        {
          householdId: 'hh-1',
          userId: OTHER,
          coveredBy: COVER,
          coveredByName: 'Cover',
          ...validDates,
          createdBy: OTHER,
          createdAt: '',
        },
      ]);
      const res = (await listVacations(
        buildEvent(),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveLength(1);
      expect(taskService.listVacationWindows).toHaveBeenCalledWith('hh-1');
    });
  });

  it('deleteTask 404s and 204s correctly', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { deleteTask } = await import('../../../src/handlers/tasks/handler.js');

    vi.mocked(taskService.deleteTask).mockResolvedValueOnce(false);
    const missing = (await deleteTask(
      buildEvent({ httpMethod: 'DELETE', pathParameters: { id: 'x' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(missing.statusCode).toBe(404);

    vi.mocked(taskService.deleteTask).mockResolvedValueOnce(true);
    const ok = (await deleteTask(
      buildEvent({ httpMethod: 'DELETE', pathParameters: { id: 't1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(ok.statusCode).toBe(204);
  });
});
