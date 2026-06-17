/**
 * Unit tests for the PUBLIC (auth=none) plant-sitter Lambda handlers
 * (handlers/tasks/handler.ts: getSitterView / completeSitterTask). These run
 * the real middy stack — so unlike the local-server integration tests, they
 * exercise the IP rate-limit middleware and confirm the handlers work with NO
 * Cognito authorizer on the event (genuinely anonymous).
 *
 * sitterService + taskService are mocked so we test the handler wiring (token
 * validation gate, cross-household guard, PII-free projection, rate limit) in
 * isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/sitterService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));

const ctx = {} as Context;

/** Anonymous event — NO authorizer claims, as the gateway delivers for an
 *  auth=none route. Each call uses a unique IP unless one is pinned, so the
 *  per-route IP rate-limit buckets don't bleed across tests. */
function anonEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
  ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}`
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/sitter/x',
    pathParameters: {},
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: ip },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const TOKEN = 'a'.repeat(64);
function activeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    token: TOKEN,
    householdId: 'hh-1',
    createdBy: 'u1',
    createdAt: 'now',
    startsAt: 'now',
    expiresAt: '2999-01-01T00:00:00.000Z',
    status: 'active',
    label: 'Our plants',
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
});

describe('GET /sitter/{token} (public)', () => {
  it('returns the PII-free due-task list for a valid token, no auth required', async () => {
    const { getActiveLink } = await import('../../../src/services/sitterService.js');
    const { getSitterTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getSitterTasks).mockResolvedValueOnce([
      { taskId: 't1', plantName: 'Monstera', taskType: 'water', dueDate: 'now', overdue: true },
    ] as never);

    const { getSitterView } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await getSitterView(
      anonEvent({ path: '/sitter/' + TOKEN, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.label).toBe('Our plants');
    expect(body.tasks[0]).toEqual({
      taskId: 't1',
      plantName: 'Monstera',
      taskType: 'water',
      dueDate: 'now',
      overdue: true,
    });
    // No member identity / household id leaked anywhere in the payload.
    expect(res.body).not.toContain('hh-1');
    expect(res.body).not.toContain('createdBy');
  });

  it('404s (generic) on an invalid/expired/revoked token', async () => {
    const { getActiveLink } = await import('../../../src/services/sitterService.js');
    vi.mocked(getActiveLink).mockResolvedValueOnce(null);
    const { getSitterView } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await getSitterView(
      anonEvent({ pathParameters: { token: 'bad' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('applies an IP rate limit (429 after 60 requests/min)', async () => {
    const { getActiveLink } = await import('../../../src/services/sitterService.js');
    const { getSitterTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveLink).mockResolvedValue(activeLink() as never);
    vi.mocked(getSitterTasks).mockResolvedValue([] as never);
    const { getSitterView } = await import('../../../src/handlers/tasks/handler.js');

    // Pin one IP so all requests share a bucket.
    const event = () =>
      anonEvent({ path: '/sitter/' + TOKEN, pathParameters: { token: TOKEN } }, '203.0.113.9');
    for (let i = 0; i < 60; i++) {
      const r = (await getSitterView(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(r.statusCode).toBe(200);
    }
    const limited = (await getSitterView(event(), ctx, () => {})) as APIGatewayProxyResult;
    expect(limited.statusCode).toBe(429);
  });
});

describe('POST /sitter/{token}/tasks/{taskId}/complete (public)', () => {
  it('completes a task in the token household and returns the PII-free shape', async () => {
    const { getActiveLink } = await import('../../../src/services/sitterService.js');
    const { getTask, completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getTask).mockResolvedValueOnce({ id: 't1', householdId: 'hh-1' } as never);
    vi.mocked(completeTask).mockResolvedValueOnce({
      id: 't1',
      plantId: 'p1',
      plantName: 'Monstera',
      type: 'water',
      customType: null,
      nextDue: '2999-01-02T00:00:00.000Z',
    } as never);

    const { completeSitterTask } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await completeSitterTask(
      anonEvent({
        httpMethod: 'POST',
        path: `/sitter/${TOKEN}/tasks/t1/complete`,
        pathParameters: { token: TOKEN, taskId: 't1' },
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      taskId: 't1',
      plantName: 'Monstera',
      taskType: 'water',
      dueDate: '2999-01-02T00:00:00.000Z',
      overdue: false,
    });

    // The completion was attributed to "a plant sitter", not a real user.
    expect(vi.mocked(completeTask)).toHaveBeenCalledWith(
      'hh-1',
      't1',
      'sitter:link-1',
      'a plant sitter'
    );
  });

  it('rejects a task that belongs to ANOTHER household (cross-household guard → 404)', async () => {
    const { getActiveLink } = await import('../../../src/services/sitterService.js');
    const { getTask, completeTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveLink).mockResolvedValueOnce(activeLink() as never);
    // getTask is scoped to the token's household; a foreign task simply isn't found.
    vi.mocked(getTask).mockResolvedValueOnce(null);

    const { completeSitterTask } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await completeSitterTask(
      anonEvent({
        httpMethod: 'POST',
        pathParameters: { token: TOKEN, taskId: 'foreign-task' },
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(completeTask)).not.toHaveBeenCalled();
  });

  it('404s when the token is expired/revoked (re-validated on the write path)', async () => {
    const { getActiveLink } = await import('../../../src/services/sitterService.js');
    vi.mocked(getActiveLink).mockResolvedValueOnce(null);
    const { completeSitterTask } = await import('../../../src/handlers/tasks/handler.js');
    const res = (await completeSitterTask(
      anonEvent({ httpMethod: 'POST', pathParameters: { token: TOKEN, taskId: 't1' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });
});
