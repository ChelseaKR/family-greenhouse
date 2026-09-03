/**
 * Double-care detection + schedule drift through the REAL task/household
 * handlers (middy chain, validation, error shaping) with the services mocked.
 * The contract under test, per the brief (§4.7): a suspected duplicate is
 * never logged silently and never dropped silently; a plan the detector
 * cannot read never blocks care logging; drift is null-with-reason below the
 * minimum history, never a fabricated 0%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/spaceService.js');
vi.mock('../../../src/services/sitterService.js');
vi.mock('../../../src/services/welcomeEmail.js');
vi.mock('../../../src/services/accountCleanup.js');
vi.mock('../../../src/services/cognitoUsers.js');
vi.mock('../../../src/services/activity.js', () => ({
  recordActivity: vi.fn(async () => undefined),
}));
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
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('../../../src/services/doubleCare.js', () => ({
  findRecentDuplicate: vi.fn(async () => ({ status: 'clear' })),
  countConfirmedDuplicatesThisMonth: vi.fn(async () => ({
    status: 'ok',
    month: '2026-09',
    confirmedDuplicates: 0,
  })),
  getScheduleDriftForPlant: vi.fn(async () => []),
  getScheduleDriftForTask: vi.fn(),
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

function jsonPost(pathParameters: Record<string, string>, body: unknown): APIGatewayProxyEvent {
  return buildEvent({
    httpMethod: 'POST',
    pathParameters,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const fakeContext = {} as Context;

const task = {
  id: 't1',
  householdId: 'hh-1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water' as const,
  customType: null,
  frequency: 7,
  lastCompleted: '2026-09-01T09:00:00.000Z',
  nextDue: '2026-09-08T09:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  assignmentSource: null,
  notes: null,
  createdBy: 'user-1',
  createdAt: '',
};

const duplicate = {
  completionId: 'c-sam',
  completedAt: '2026-09-03T08:00:00.000Z',
  completedBy: 'user-sam',
  completedByName: 'Sam',
  taskId: 't1',
  taskType: 'water',
  sameTask: true,
  windowHours: 24,
};

async function setPlan(planId: string) {
  const billing = await import('../../../src/services/billing.js');
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId } as never);
}

describe('double-care detection on POST /tasks/{id}/complete', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setPlan('garden');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTask).mockResolvedValue(task);
    vi.mocked(taskService.completeTask).mockResolvedValue({ ...task, nextDue: 'advanced' });
    const doubleCare = await import('../../../src/services/doubleCare.js');
    vi.mocked(doubleCare.findRecentDuplicate).mockResolvedValue({ status: 'clear' });
  });

  it('answers 409 DUPLICATE_CARE and logs NOTHING when another member already did it', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(doubleCare.findRecentDuplicate).mockResolvedValue({ status: 'duplicate', duplicate });

    const res = (await completeTask(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('Sam already logged water for Pothos');
    expect(body.details).toEqual({ code: 'DUPLICATE_CARE', plantName: 'Pothos', duplicate });
    expect(taskService.completeTask).not.toHaveBeenCalled();
    expect(doubleCare.findRecentDuplicate).toHaveBeenCalledWith({
      householdId: 'hh-1',
      plantId: 'p1',
      taskId: 't1',
      taskType: 'water',
      actorId: 'user-1',
    });
  });

  it('logs the completion tagged with the duplicated id when confirmDuplicate is true', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(doubleCare.findRecentDuplicate).mockResolvedValue({ status: 'duplicate', duplicate });

    const res = (await completeTask(
      jsonPost({ id: 't1' }, { confirmDuplicate: true, notes: 'topped up' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(taskService.completeTask).toHaveBeenCalledWith(
      'hh-1',
      't1',
      'user-1',
      'Tester',
      'topped up',
      undefined,
      { duplicateOfCompletionId: 'c-sam' }
    );
  });

  it('completes untagged with the six-argument call when the log is clear', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');

    const res = (await completeTask(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(taskService.completeTask).toHaveBeenCalledWith(
      'hh-1',
      't1',
      'user-1',
      'Tester',
      undefined,
      undefined
    );
  });

  it('never blocks care logging when the detector cannot read the log', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(doubleCare.findRecentDuplicate).mockResolvedValue({ status: 'unavailable' });

    const res = (await completeTask(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(taskService.completeTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskService.completeTask).mock.calls[0]).toHaveLength(6);
  });

  it('never blocks care logging when the plan cannot be read (detector skipped)', async () => {
    const billing = await import('../../../src/services/billing.js');
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValue(new Error('ddb down'));

    const res = (await completeTask(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(doubleCare.findRecentDuplicate).not.toHaveBeenCalled();
    expect(taskService.completeTask).toHaveBeenCalledTimes(1);
  });

  it('skips the detector entirely on the free tier (feature gated in plans.ts)', async () => {
    await setPlan('seedling');
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');

    const res = (await completeTask(
      jsonPost({ id: 't1' }, { confirmDuplicate: true }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(doubleCare.findRecentDuplicate).not.toHaveBeenCalled();
    expect(taskService.getTask).not.toHaveBeenCalled();
    expect(vi.mocked(taskService.completeTask).mock.calls[0]).toHaveLength(6);
  });

  it('skips the detector for a stale occurrence token (the service no-ops it)', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');

    const res = (await completeTask(
      jsonPost({ id: 't1' }, { expectedNextDue: '2026-09-01T09:00:00.000Z' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(doubleCare.findRecentDuplicate).not.toHaveBeenCalled();
    expect(taskService.completeTask).toHaveBeenCalledTimes(1);
  });

  it('404s before detecting when the task does not exist', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { completeTask } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(taskService.getTask).mockResolvedValue(null);

    const res = (await completeTask(
      jsonPost({ id: 'missing' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    expect(doubleCare.findRecentDuplicate).not.toHaveBeenCalled();
    expect(taskService.completeTask).not.toHaveBeenCalled();
  });
});

describe('GET /plants/{plantId}/schedule-drift', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setPlan('garden');
    const plantService = await import('../../../src/services/plantService.js');
    vi.mocked(plantService.getPlant).mockResolvedValue({ id: 'p1', householdId: 'hh-1' } as never);
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTasksForPlant).mockResolvedValue([task]);
  });

  it('returns the per-task readings from one plant read on a toolkit tier', async () => {
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { getPlantScheduleDrift } = await import('../../../src/handlers/tasks/handler.js');
    const reading = {
      taskId: 't1',
      scheduledIntervalDays: 7,
      completionsConsidered: 5,
      requiredCompletions: 4,
      drift: {
        medianIntervalDays: 11,
        driftPct: 0.571,
        suggestedFrequency: 11,
        exceedsThreshold: true,
      },
      reason: null,
    };
    vi.mocked(doubleCare.getScheduleDriftForPlant).mockResolvedValue([reading]);

    const res = (await getPlantScheduleDrift(
      buildEvent({ pathParameters: { plantId: 'p1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ available: true, reason: null, tasks: [reading] });
    expect(doubleCare.getScheduleDriftForPlant).toHaveBeenCalledWith('hh-1', 'p1', [task]);
  });

  it('is explicitly not_in_plan on the free tier and reads nothing', async () => {
    await setPlan('seedling');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { getPlantScheduleDrift } = await import('../../../src/handlers/tasks/handler.js');

    const res = (await getPlantScheduleDrift(
      buildEvent({ pathParameters: { plantId: 'p1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(JSON.parse(res.body)).toEqual({ available: false, reason: 'not_in_plan', tasks: [] });
    expect(doubleCare.getScheduleDriftForPlant).not.toHaveBeenCalled();
  });

  it('is explicitly plan_unavailable when the plan cannot be read', async () => {
    const billing = await import('../../../src/services/billing.js');
    const { getPlantScheduleDrift } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValue(new Error('ddb down'));

    const res = (await getPlantScheduleDrift(
      buildEvent({ pathParameters: { plantId: 'p1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(JSON.parse(res.body)).toEqual({
      available: false,
      reason: 'plan_unavailable',
      tasks: [],
    });
  });

  it('404s for an unknown plant instead of publishing an empty list', async () => {
    const plantService = await import('../../../src/services/plantService.js');
    const { getPlantScheduleDrift } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(plantService.getPlant).mockResolvedValue(null);

    const res = (await getPlantScheduleDrift(
      buildEvent({ pathParameters: { plantId: 'nope' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /tasks/{id}/match-schedule', () => {
  const driftReading = {
    taskId: 't1',
    scheduledIntervalDays: 7,
    completionsConsidered: 5,
    requiredCompletions: 4,
    drift: {
      medianIntervalDays: 11.2,
      driftPct: 0.6,
      suggestedFrequency: 11,
      exceedsThreshold: true,
    },
    reason: null as null,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await setPlan('garden');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getTask).mockResolvedValue(task);
    vi.mocked(taskService.updateTask).mockResolvedValue({ ...task, frequency: 11 });
    const doubleCare = await import('../../../src/services/doubleCare.js');
    vi.mocked(doubleCare.getScheduleDriftForTask).mockResolvedValue(driftReading);
  });

  it('sets the frequency to the server-computed median, re-derives nextDue, and audits it', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const activity = await import('../../../src/services/activity.js');
    const { matchTaskSchedule } = await import('../../../src/handlers/tasks/handler.js');

    const res = (await matchTaskSchedule(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).frequency).toBe(11);
    const [, , input] = vi.mocked(taskService.updateTask).mock.calls[0];
    expect(input.frequency).toBe(11);
    // lastCompleted 2026-09-01 + 11 days, or now if that has already passed.
    const expectedFloor = new Date('2026-09-12T09:00:00.000Z').getTime();
    expect(new Date(input.nextDue!).getTime()).toBeGreaterThanOrEqual(
      Math.min(expectedFloor, Date.now() - 1000)
    );
    expect(activity.recordActivity).toHaveBeenCalledWith({
      type: 'task.schedule_matched',
      householdId: 'hh-1',
      actorId: 'user-1',
      actorName: 'Tester',
      payload: {
        taskId: 't1',
        plantId: 'p1',
        plantName: 'Pothos',
        taskType: 'water',
        previousFrequency: 7,
        newFrequency: 11,
        medianIntervalDays: 11.2,
        completionsConsidered: 5,
      },
    });
  });

  it('402s on the free tier without touching the task', async () => {
    await setPlan('seedling');
    const taskService = await import('../../../src/services/taskService.js');
    const { matchTaskSchedule } = await import('../../../src/handlers/tasks/handler.js');

    const res = (await matchTaskSchedule(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(402);
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });

  it('409s when there is no drift to match (too little history is not 0% drift)', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { matchTaskSchedule } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(doubleCare.getScheduleDriftForTask).mockResolvedValue({
      ...driftReading,
      completionsConsidered: 2,
      drift: null,
      reason: 'insufficient_completions',
    });

    const res = (await matchTaskSchedule(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(409);
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });

  it('503s — changing nothing — when the history cannot be read', async () => {
    const taskService = await import('../../../src/services/taskService.js');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { matchTaskSchedule } = await import('../../../src/handlers/tasks/handler.js');
    vi.mocked(doubleCare.getScheduleDriftForTask).mockResolvedValue({
      ...driftReading,
      completionsConsidered: 0,
      drift: null,
      reason: 'history_unavailable',
    });

    const res = (await matchTaskSchedule(
      jsonPost({ id: 't1' }, {}),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).message).toContain('completion history');
    expect(taskService.updateTask).not.toHaveBeenCalled();
  });
});

describe('GET /households/{id}/analytics/daily doubleCare field', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setPlan('garden');
    const taskService = await import('../../../src/services/taskService.js');
    vi.mocked(taskService.getDailyCompletionCounts).mockResolvedValue([]);
  });

  it('carries the monthly confirmed-duplicate count on a toolkit tier', async () => {
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { getDailyAnalytics } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(doubleCare.countConfirmedDuplicatesThisMonth).mockResolvedValue({
      status: 'ok',
      month: '2026-09',
      confirmedDuplicates: 3,
    });

    const res = (await getDailyAnalytics(
      buildEvent({ pathParameters: { id: 'hh-1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      days: 30,
      series: [],
      // A toolkit tier has no analytics ceiling (ADR 0014): null is "no
      // limit", never "unknown".
      historyLimitDays: null,
      doubleCare: { status: 'ok', month: '2026-09', confirmedDuplicates: 3 },
    });
  });

  it('is explicitly not_in_plan on the free tier', async () => {
    await setPlan('seedling');
    const doubleCare = await import('../../../src/services/doubleCare.js');
    const { getDailyAnalytics } = await import('../../../src/handlers/households/handler.js');

    const res = (await getDailyAnalytics(
      buildEvent({ pathParameters: { id: 'hh-1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(JSON.parse(res.body).doubleCare).toEqual({ status: 'not_in_plan' });
    expect(doubleCare.countConfirmedDuplicatesThisMonth).not.toHaveBeenCalled();
  });

  it('is explicitly unavailable — never 0 — when the plan cannot be read', async () => {
    const billing = await import('../../../src/services/billing.js');
    const { getDailyAnalytics } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValue(new Error('ddb down'));

    const res = (await getDailyAnalytics(
      buildEvent({ pathParameters: { id: 'hh-1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).doubleCare).toEqual({ status: 'unavailable' });
  });
});
