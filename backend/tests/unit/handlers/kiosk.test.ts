/**
 * Unit tests for the kiosk (wall display) Lambda handlers — both the PUBLIC
 * pair in handlers/tasks/kiosk.ts (auth=none) and the admin-gated management
 * trio in handlers/households/kioskLink.ts.
 *
 * These run the real middy stack, so they also exercise the IP rate limit on
 * the public routes and prove the public handlers work with NO Cognito
 * authorizer on the event (genuinely anonymous).
 *
 * The properties asserted here are the threat model's load-bearing ones:
 * scope (exactly two public operations, PII-free), the cross-household guard,
 * the generic 404, a revoke that bites mid-session, the Greenhouse gate on
 * issue, the ungated revoke, and the fact that a failed read surfaces as an
 * error rather than an empty/absent kiosk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/kioskService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/kioskService.js')>();
  return {
    ...actual,
    getActiveKioskLink: vi.fn(),
    issueKioskLink: vi.fn(),
    getCurrentKioskLink: vi.fn(),
    revokeKioskLinks: vi.fn(),
  };
});
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/billing.js');
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock('../../../src/utils/auditLog.js', () => ({ audit: vi.fn() }));

const ctx = {} as Context;
const TOKEN = 'a'.repeat(64);

/** Anonymous event — NO authorizer claims, as the gateway delivers for an
 *  auth=none route. Unique IP per call so rate-limit buckets don't bleed. */
function anonEvent(
  overrides: Partial<APIGatewayProxyEvent> = {},
  ip = `10.1.0.${Math.floor(Math.random() * 250) + 1}`
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/kiosk/x',
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

function activeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kiosk-1',
    token: TOKEN,
    householdId: 'hh-1',
    createdBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    pollIntervalSeconds: 300,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
});

describe('GET /kiosk/{token} (public)', () => {
  it('returns today’s tasks and the poll interval, no auth required', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    const { getSitterTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getSitterTasks).mockResolvedValueOnce([
      {
        taskId: 't1',
        plantName: 'Monstera',
        taskType: 'water',
        dueDate: '2026-09-03T09:00:00.000Z',
        spaceName: 'Kitchen',
        placementNote: 'by the sink',
        overdue: true,
      },
    ] as never);

    const { getKioskView } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await getKioskView(
      anonEvent({ path: `/kiosk/${TOKEN}`, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pollIntervalSeconds).toBe(300);
    expect(body.tasks).toHaveLength(1);
    // Scope: the payload carries no household name, no member, no label.
    expect(Object.keys(body).sort()).toEqual(['pollIntervalSeconds', 'tasks']);
  });

  it('is NOT entitlement-gated, deliberately: a mounted display keeps working while the card has failed (#476)', async () => {
    // The kiosk is a screen on a wall and the people reading it are not the
    // buyer. Entitlement is asked once, when the link is ISSUED; revoking it
    // is the control. The billing service is never consulted on this path,
    // and this test is what keeps that a decision rather than an omission.
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    const { getSitterTasks } = await import('../../../src/services/taskService.js');
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getSitterTasks).mockResolvedValueOnce([] as never);
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'seedling',
      status: 'past_due',
    } as never);

    const { getKioskView } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await getKioskView(
      anonEvent({ path: `/kiosk/${TOKEN}`, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('supplies its own rolling cutoff, not a sitter link’s expiresAt', async () => {
    const { getActiveKioskLink, KIOSK_LOOKAHEAD_DAYS } =
      await import('../../../src/services/kioskService.js');
    const { getSitterTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getSitterTasks).mockResolvedValueOnce([] as never);

    const before = Date.now();
    const { getKioskView } = await import('../../../src/handlers/tasks/kiosk.js');
    await getKioskView(
      anonEvent({ path: `/kiosk/${TOKEN}`, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    );
    const after = Date.now();

    // The sitter view's cutoff is its link's own expiresAt (ADR 0015). A wall
    // display has no expiry to honour, so it passes a rolling horizon of
    // KIOSK_LOOKAHEAD_DAYS instead — "what needs doing today", not a trip.
    const windowEndsAt = Date.parse(vi.mocked(getSitterTasks).mock.calls[0][1] as string);
    const day = 24 * 60 * 60 * 1000;
    expect(windowEndsAt).toBeGreaterThanOrEqual(before + KIOSK_LOOKAHEAD_DAYS * day);
    expect(windowEndsAt).toBeLessThanOrEqual(after + KIOSK_LOOKAHEAD_DAYS * day);
    // Deliberately far short of the sitter view's old seven-day horizon.
    expect(windowEndsAt).toBeLessThan(before + 2 * day);
  });

  it('answers a generic 404 for an invalid or revoked token', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValue(null as never);

    const { getKioskView } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await getKioskView(
      anonEvent({ path: `/kiosk/${TOKEN}`, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    // One message for every failure mode — no token-existence oracle.
    expect(JSON.parse(res.body).message).toBe('This kiosk link is invalid or has been turned off.');
  });

  it('fails loudly when the task read throws — never an empty "all done" list', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    const { getSitterTasks } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getSitterTasks).mockRejectedValueOnce(new Error('dynamo down') as never);

    const { getKioskView } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await getKioskView(
      anonEvent({ path: `/kiosk/${TOKEN}`, pathParameters: { token: TOKEN } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    // ADR 0010. On a wall screen an empty list reads as "everything is done"
    // and nobody would question it, so the read failure has to be a 5xx.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('rate-limits a single IP to blunt scraping', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValue(null as never);
    const { getKioskView } = await import('../../../src/handlers/tasks/kiosk.js');

    let last: APIGatewayProxyResult | undefined;
    for (let i = 0; i < 61; i += 1) {
      last = (await getKioskView(
        anonEvent({ path: `/kiosk/${TOKEN}`, pathParameters: { token: TOKEN } }, '10.9.9.9'),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
    }
    expect(last?.statusCode).toBe(429);
  });
});

describe('POST /kiosk/{token}/tasks/{taskId}/complete (public)', () => {
  function completeEvent(body: unknown = {}) {
    return anonEvent({
      httpMethod: 'POST',
      path: `/kiosk/${TOKEN}/tasks/t1/complete`,
      pathParameters: { token: TOKEN, taskId: 't1' },
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('completes the task and attributes it to the kiosk, not a person', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    const { getTask, completeTask } = await import('../../../src/services/taskService.js');
    const { recordActivity } = await import('../../../src/services/activity.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getTask).mockResolvedValueOnce({
      id: 't1',
      plantId: 'p1',
      plantName: 'Monstera',
      type: 'water',
      nextDue: '2026-09-03T09:00:00.000Z',
    } as never);
    vi.mocked(completeTask).mockResolvedValueOnce({
      id: 't1',
      plantId: 'p1',
      plantName: 'Monstera',
      type: 'water',
      nextDue: '2026-09-10T09:00:00.000Z',
    } as never);

    const { completeKioskTask } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await completeKioskTask(completeEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(completeTask).mock.calls[0][2]).toBe('kiosk:kiosk-1');
    expect(vi.mocked(completeTask).mock.calls[0][3]).toBe('the kiosk display');
    const activityArg = vi.mocked(recordActivity).mock.calls[0][0] as unknown as {
      actorId: string;
      payload: Record<string, unknown>;
    };
    // A household must be able to SEE that a completion came off the wall
    // screen — that is how a leaked token gets noticed.
    expect(activityArg.actorId).toBe('kiosk:kiosk-1');
    expect(activityArg.payload.viaKiosk).toBe(true);
  });

  it('404s when the task belongs to another household', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    const { getTask } = await import('../../../src/services/taskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    // getTask is read scoped to the token's household, so a foreign id misses.
    vi.mocked(getTask).mockResolvedValueOnce(undefined as never);

    const { completeKioskTask } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await completeKioskTask(completeEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
    expect(vi.mocked(getTask).mock.calls[0][0]).toBe('hh-1');
  });

  it('404s when the token was revoked while the page was open', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(null as never);

    const { completeKioskTask } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await completeKioskTask(completeEvent(), ctx, () => {})) as APIGatewayProxyResult;
    // Revocation is the whole remedy for a leaked token, so it has to bite
    // mid-session rather than only at the next page load.
    expect(res.statusCode).toBe(404);
  });

  it('does not double-complete when the occurrence already moved on', async () => {
    const { getActiveKioskLink } = await import('../../../src/services/kioskService.js');
    const { getTask, completeTask } = await import('../../../src/services/taskService.js');
    const { recordActivity } = await import('../../../src/services/activity.js');
    vi.mocked(getActiveKioskLink).mockResolvedValueOnce(activeLink() as never);
    vi.mocked(getTask).mockResolvedValueOnce({
      id: 't1',
      plantId: 'p1',
      plantName: 'Monstera',
      type: 'water',
      nextDue: '2026-09-10T09:00:00.000Z',
    } as never);

    const { completeKioskTask } = await import('../../../src/handlers/tasks/kiosk.js');
    const res = (await completeKioskTask(
      completeEvent({ expectedNextDue: '2026-09-03T09:00:00.000Z' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(completeTask).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Management side
// ---------------------------------------------------------------------------

const adminClaims = {
  sub: 'user-1',
  email: 'a@b.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'admin',
};

function authedEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/kiosk-link',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: null,
    requestContext: {
      identity: { sourceIp: '10.2.0.1' },
      authorizer: { claims: adminClaims },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

/** authMiddleware validates the claim household against the membership table.
 *  Pre-warm the cache so the management tests exercise the handler, not the
 *  membership lookup. */
beforeEach(async () => {
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('user-1', 'hh-1', 'admin');
  process.env.FRONTEND_URL = 'https://app.example.test';
});

describe('POST /households/{id}/kiosk-link (issue)', () => {
  it('is gated to Greenhouse via plans.features.kiosk', async () => {
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);

    const { issueKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await issueKioskLink(
      authedEvent({ body: JSON.stringify({}) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(402);
  });

  it('issues the token and URL exactly once for a Greenhouse household', async () => {
    const billing = await import('../../../src/services/billing.js');
    const kiosk = await import('../../../src/services/kioskService.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'greenhouse',
    } as never);
    vi.mocked(kiosk.issueKioskLink).mockResolvedValueOnce({
      id: 'kiosk-1',
      token: TOKEN,
      householdId: 'hh-1',
      createdBy: 'u1',
      createdAt: 'now',
      status: 'active',
      pollIntervalSeconds: 300,
    } as never);

    const { issueKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await issueKioskLink(
      authedEvent({ body: JSON.stringify({ pollIntervalSeconds: 600 }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token).toBe(TOKEN);
    expect(body.url).toBe(`https://app.example.test/kiosk/${TOKEN}`);
    expect(vi.mocked(kiosk.issueKioskLink).mock.calls[0][0].pollIntervalSeconds).toBe(600);
  });

  it.each(['past_due', 'unpaid', 'incomplete', 'paused', 'canceled'])(
    '402s while the card has failed (%s) — mounting a NEW display is a new grant (#476)',
    async (status) => {
      const billing = await import('../../../src/services/billing.js');
      const kiosk = await import('../../../src/services/kioskService.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
        planId: 'greenhouse',
        status,
      } as never);

      const { issueKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
      const res = (await issueKioskLink(
        authedEvent({ body: JSON.stringify({}) }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(402);
      expect(kiosk.issueKioskLink).not.toHaveBeenCalled();
    }
  );

  it('still issues for a lifetime Greenhouse owner after a later cancellation (#476)', async () => {
    const billing = await import('../../../src/services/billing.js');
    const kiosk = await import('../../../src/services/kioskService.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'seedling',
      status: 'canceled',
      lifetimePlanId: 'greenhouse',
    } as never);
    vi.mocked(kiosk.issueKioskLink).mockResolvedValueOnce({
      id: 'kiosk-1',
      token: TOKEN,
      householdId: 'hh-1',
      createdBy: 'u1',
      createdAt: 'now',
      status: 'active',
      pollIntervalSeconds: 300,
    } as never);

    const { issueKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await issueKioskLink(
      authedEvent({ body: JSON.stringify({}) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
  });

  it('rejects a poll interval outside the supported band', async () => {
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'greenhouse',
    } as never);

    const { issueKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await issueKioskLink(
      authedEvent({ body: JSON.stringify({ pollIntervalSeconds: 5 }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /households/{id}/kiosk-link', () => {
  it('returns the summary without the token', async () => {
    const kiosk = await import('../../../src/services/kioskService.js');
    vi.mocked(kiosk.getCurrentKioskLink).mockResolvedValueOnce({
      id: 'kiosk-1',
      householdId: 'hh-1',
      createdBy: 'u1',
      createdAt: 'now',
      status: 'active',
      pollIntervalSeconds: 300,
    } as never);

    const { getKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await getKioskLink(
      authedEvent({ httpMethod: 'GET' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.link.id).toBe('kiosk-1');
    // A screenshot of the settings page must not be a credential.
    expect(body.link).not.toHaveProperty('token');
  });

  it('surfaces a failed read as an error, not as "no kiosk link"', async () => {
    const kiosk = await import('../../../src/services/kioskService.js');
    vi.mocked(kiosk.getCurrentKioskLink).mockRejectedValueOnce(new Error('dynamo down') as never);

    const { getKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await getKioskLink(
      authedEvent({ httpMethod: 'GET' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});

describe('DELETE /households/{id}/kiosk-link (revoke)', () => {
  it('revokes without a plan check — turning a display off is never gated', async () => {
    const billing = await import('../../../src/services/billing.js');
    const kiosk = await import('../../../src/services/kioskService.js');
    vi.mocked(kiosk.revokeKioskLinks).mockResolvedValueOnce(1 as never);

    const { revokeKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await revokeKioskLink(
      authedEvent({ httpMethod: 'DELETE' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(204);
    // A downgraded household must still be able to kill its wall display.
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('404s when there was nothing live to revoke', async () => {
    const kiosk = await import('../../../src/services/kioskService.js');
    vi.mocked(kiosk.revokeKioskLinks).mockResolvedValueOnce(0 as never);

    const { revokeKioskLink } = await import('../../../src/handlers/households/kioskLink.js');
    const res = (await revokeKioskLink(
      authedEvent({ httpMethod: 'DELETE' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
  });
});
