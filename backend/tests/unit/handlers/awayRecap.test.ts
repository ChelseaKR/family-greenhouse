/**
 * Unit tests for the members-only Away Kit recap handler
 * (handlers/households/awayRecap.ts). The three explicit non-200 outcomes
 * matter as much as the 200: a locked tier (402), no ended window (404),
 * and a failed read (5xx) must each be distinguishable from "nothing
 * happened while you were away".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/sitterService.js');
vi.mock('../../../src/services/awayRecapService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/awayRecapService.js')>();
  return { ...actual, listSitterWindowActivity: vi.fn() };
});
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));

const ctx = {} as Context;

function buildEvent(
  claims: Record<string, unknown> | null,
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/away-recap',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: null,
    requestContext: {
      authorizer: claims ? { claims } : undefined,
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const memberClaims = {
  sub: 'user-2',
  email: 'm@b.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'member',
};

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    token: 'a'.repeat(64),
    householdId: 'hh-1',
    createdBy: 'u1',
    createdAt: '2026-08-01T00:00:00.000Z',
    startsAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
    status: 'active',
    label: 'Our plants',
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  // A plain MEMBER — the recap is not admin-gated.
  setCachedMembership('user-2', 'hh-1', 'member');
  const billing = await import('../../../src/services/billing.js');
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);
});

describe('GET /households/{id}/away-recap', () => {
  it('returns the recap of the most recently ended link to any household member', async () => {
    const sitterService = await import('../../../src/services/sitterService.js');
    const recapService = await import('../../../src/services/awayRecapService.js');
    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([
      link({ id: 'live', expiresAt: '2999-01-01T00:00:00.000Z' }),
      link(),
    ] as never);
    vi.mocked(recapService.listSitterWindowActivity).mockResolvedValueOnce({
      events: [
        {
          id: 'e1',
          type: 'task.completed',
          householdId: 'hh-1',
          actorId: 'sitter:link-1',
          actorName: 'a plant sitter',
          occurredAt: '2026-08-12T09:00:00.000Z',
          payload: {
            taskId: 't1',
            plantId: 'p1',
            plantName: 'Fern',
            taskType: 'water',
            viaSitter: true,
          },
        },
      ],
      truncated: false,
    } as never);
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');

    const res = (await getAwayRecap(
      buildEvent(memberClaims),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.link).toMatchObject({ id: 'link-1', label: 'Our plants', ended: true });
    expect(body.tasksCompleted).toHaveLength(1);
    expect(body.tasksCompleted[0]).toMatchObject({
      plantName: 'Fern',
      actorName: 'a plant sitter',
    });
    expect(body.counts).toEqual({ tasks: 1, photos: 0, notes: 0 });
    expect(body.truncated).toBe(false);
    // The secret token never leaves the service layer.
    expect(res.body).not.toContain('a'.repeat(64));
    expect(recapService.listSitterWindowActivity).toHaveBeenCalledWith(
      'hh-1',
      expect.objectContaining({ id: 'link-1' }),
      expect.any(Date)
    );
  });

  it('recaps an explicitly requested link, even one still open', async () => {
    const sitterService = await import('../../../src/services/sitterService.js');
    const recapService = await import('../../../src/services/awayRecapService.js');
    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([
      link({ id: 'live', expiresAt: '2999-01-01T00:00:00.000Z' }),
    ] as never);
    vi.mocked(recapService.listSitterWindowActivity).mockResolvedValueOnce({
      events: [],
      truncated: false,
    });
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');

    const res = (await getAwayRecap(
      buildEvent(memberClaims, { queryStringParameters: { linkId: 'live' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).link).toMatchObject({ id: 'live', ended: false });
  });

  it('404s with an explicit message when no window has ended yet (not an empty recap)', async () => {
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([
      link({ expiresAt: '2999-01-01T00:00:00.000Z' }),
    ] as never);
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');

    const res = (await getAwayRecap(
      buildEvent(memberClaims),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toBe('No sitter window has ended yet');
  });

  it('402s when the plan lacks the Away Kit, before any link read', async () => {
    const billing = await import('../../../src/services/billing.js');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
    } as never);
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');

    const res = (await getAwayRecap(
      buildEvent(memberClaims),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(402);
    expect(sitterService.listSitterLinks).not.toHaveBeenCalled();
  });

  it('403s a caller whose active household is not the one in the path', async () => {
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');
    const res = (await getAwayRecap(
      buildEvent(memberClaims, { pathParameters: { id: 'hh-other' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('401s without a JWT', async () => {
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');
    const res = (await getAwayRecap(buildEvent(null), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
  });

  it('answers 5xx when the activity read fails — never a recap that says nothing happened', async () => {
    const sitterService = await import('../../../src/services/sitterService.js');
    const recapService = await import('../../../src/services/awayRecapService.js');
    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([link()] as never);
    vi.mocked(recapService.listSitterWindowActivity).mockRejectedValueOnce(new Error('ddb'));
    const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');

    const res = (await getAwayRecap(
      buildEvent(memberClaims),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('tasksCompleted');
  });

  it('is registered on the households group router', async () => {
    const { handler } = await import('../../../src/handlers/households/handler.js');
    expect(handler.routes).toContain('GET /households/{id}/away-recap');
  });
});
