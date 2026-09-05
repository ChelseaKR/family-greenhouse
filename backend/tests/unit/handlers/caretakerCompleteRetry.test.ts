/**
 * POST /caretaker/{token}/tasks/{taskId}/complete — what the early-return
 * branch tells a caretaker about the visit record (#604).
 *
 * `expectedNextDue` exists because a completion's response can be lost: the
 * task completes server-side, the caretaker never hears, and they tap again.
 * The second request finds the schedule already advanced and returns early,
 * writing — as its own comment says — no second completion, no activity row
 * and no visit line.
 *
 * It answered `visitRecorded: true` anyway. That boolean is the sole trigger
 * for the one warning built to surface a gap in the visit record
 * (`CaretakerPage`: `if (!result.visitRecorded) setRecordGap(true)`), so the
 * exact sequence `expectedNextDue` exists for — visit write fails, response is
 * lost, helper taps again — ended with the warning suppressed, a paid helper
 * told their work was on the household's record, and a hole in the report
 * nobody was told about. The caretaker cannot open that report to check.
 *
 * The branch cannot know whether the earlier attempt wrote a line
 * (`recordVisitAction` swallows a failed write), so it reports the line THIS
 * request did not write: `false`. An unknown reported as `true` is the one
 * answer that cannot be right.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/caretakerService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/caretakerService.js')>();
  return { ...actual, getActiveCaretaker: vi.fn(), recordCaretakerAction: vi.fn() };
});
vi.mock('../../../src/services/taskService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/taskService.js')>();
  return { ...actual, getTask: vi.fn(), completeTask: vi.fn() };
});
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn() }));

import * as caretakerService from '../../../src/services/caretakerService.js';
import * as taskService from '../../../src/services/taskService.js';
import { recordActivity } from '../../../src/services/activity.js';

const TOKEN = 'c'.repeat(64);
const ORIGINAL_DUE = '2026-09-05T09:00:00.000Z';
const ADVANCED_DUE = '2026-09-12T09:00:00.000Z';

const SEAT = {
  id: 'seat-1',
  householdId: 'hh-1',
  name: 'Dana',
  startsAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-30T00:00:00.000Z',
  status: 'active',
} as unknown as Awaited<ReturnType<typeof caretakerService.getActiveCaretaker>>;

const task = (nextDue: string) =>
  ({
    id: 't1',
    householdId: 'hh-1',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    frequency: 7,
    nextDue,
  }) as unknown as Awaited<ReturnType<typeof taskService.getTask>>;

function buildEvent(expectedNextDue: string): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({ expectedNextDue }),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: `/caretaker/${TOKEN}/tasks/t1/complete`,
    pathParameters: { token: TOKEN, taskId: 't1' },
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const ctx = {} as Context;

async function subject() {
  return (await import('../../../src/handlers/caretakers/public.js')).completeCaretakerTask;
}

async function call(handler: Awaited<ReturnType<typeof subject>>, expectedNextDue: string) {
  const res = (await handler(buildEvent(expectedNextDue), ctx, () => {})) as APIGatewayProxyResult;
  return { res, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe('completeCaretakerTask — the visit-record claim on a replayed completion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    vi.mocked(caretakerService.getActiveCaretaker).mockResolvedValue(SEAT);
  });

  it('does not claim a visit line on a replay whose first attempt failed to write one', async () => {
    const complete = await subject();

    // Request 1: the completion lands, the visit write fails, and the response
    // never reaches the caretaker. This is the scenario `expectedNextDue` was
    // added for, and the only one in which the helper taps twice.
    vi.mocked(taskService.getTask).mockResolvedValueOnce(task(ORIGINAL_DUE));
    vi.mocked(taskService.completeTask).mockResolvedValueOnce(task(ADVANCED_DUE));
    vi.mocked(caretakerService.recordCaretakerAction).mockRejectedValueOnce(
      new Error('dynamodb unavailable')
    );
    const first = await call(complete, ORIGINAL_DUE);
    expect(first.body.visitRecorded).toBe(false);

    // Request 2: the same tap, replayed with the due date the page still shows.
    // The schedule has advanced, so this takes the early return.
    vi.mocked(taskService.getTask).mockResolvedValueOnce(task(ADVANCED_DUE));
    const second = await call(complete, ORIGINAL_DUE);

    expect(second.res.statusCode).toBe(200);
    // The whole point: a branch that writes no visit line must not report one.
    expect(second.body.visitRecorded).not.toBe(true);
    expect(second.body.visitRecorded).toBe(false);

    // …and it still must not double-complete or double-log.
    expect(taskService.completeTask).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(caretakerService.recordCaretakerAction).toHaveBeenCalledTimes(1);
  });

  it('does not claim a visit line when somebody else completed the task first', async () => {
    // The same branch, reached without any earlier request from this caretaker
    // at all — a household member or the kiosk ticked it off in between. Here
    // there is certainly no visit line with this caretaker's name on it.
    const complete = await subject();
    vi.mocked(taskService.getTask).mockResolvedValueOnce(task(ADVANCED_DUE));

    const { res, body } = await call(complete, ORIGINAL_DUE);

    expect(res.statusCode).toBe(200);
    expect(body.visitRecorded).toBe(false);
    expect(taskService.completeTask).not.toHaveBeenCalled();
    expect(caretakerService.recordCaretakerAction).not.toHaveBeenCalled();
  });

  it('still reports a visit line the completion actually wrote', async () => {
    // The honest path is untouched: `visitRecorded` there is the real return
    // of `recordVisitAction`, so a successful write still reads `true` and the
    // caretaker sees no warning.
    const complete = await subject();
    vi.mocked(taskService.getTask).mockResolvedValueOnce(task(ORIGINAL_DUE));
    vi.mocked(taskService.completeTask).mockResolvedValueOnce(task(ADVANCED_DUE));
    vi.mocked(caretakerService.recordCaretakerAction).mockResolvedValueOnce('visit-1');

    const { res, body } = await call(complete, ORIGINAL_DUE);

    expect(res.statusCode).toBe(200);
    expect(body.visitRecorded).toBe(true);
    expect(body.plantName).toBe('Monstera');
  });
});
