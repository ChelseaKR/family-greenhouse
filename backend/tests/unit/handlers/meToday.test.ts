import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/crossHomeToday.js', () => ({
  resolveEntitlement: vi.fn(),
  buildCrossHomeToday: vi.fn(),
}));

import * as householdService from '../../../src/services/householdService.js';
import * as crossHome from '../../../src/services/crossHomeToday.js';
import { myToday } from '../../../src/handlers/me/today.js';

// No `custom:household_id` claim on purpose: the route is not household-
// pinned, and a caller with no default household must still be served.
function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/me/today',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: { claims: { sub: 'user-1', email: 'test@example.com' } },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/me/today',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

const MEMBERSHIPS = [
  { householdId: 'hh-home', role: 'admin' as const, name: 'Test User', joinedAt: '' },
  { householdId: 'hh-beach', role: 'member' as const, name: 'Test User', joinedAt: '' },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(MEMBERSHIPS);
});

describe('GET /me/today', () => {
  it('401s an unauthenticated request', async () => {
    const res = await myToday(
      buildEvent({ requestContext: {} as APIGatewayProxyEvent['requestContext'] }),
      ctx
    );
    expect(res.statusCode).toBe(401);
  });

  it('400s a cutoff that is not a date-time, before touching entitlement', async () => {
    const res = await myToday(buildEvent({ queryStringParameters: { until: 'garbage' } }), ctx);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/ISO-8601/);
    expect(crossHome.resolveEntitlement).not.toHaveBeenCalled();
  });

  it('400s a cutoff that is not today', async () => {
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await myToday(buildEvent({ queryStringParameters: { until: nextMonth } }), ctx);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/48 hours/);
  });

  it('402s — not 404s — when no household of the caller includes the view, naming the tier', async () => {
    vi.mocked(crossHome.resolveEntitlement).mockResolvedValue('locked');
    const res = await myToday(buildEvent(), ctx);
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).message).toMatch(/Greenhouse/);
    expect(crossHome.buildCrossHomeToday).not.toHaveBeenCalled();
  });

  it('503s, with the reason exposed, when entitlement could not be read', async () => {
    vi.mocked(crossHome.resolveEntitlement).mockResolvedValue('unverifiable');
    const res = await myToday(buildEvent(), ctx);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).message).toMatch(/couldn't confirm your plan/);
    expect(crossHome.buildCrossHomeToday).not.toHaveBeenCalled();
  });

  it('returns the grouped queue for every membership, uncached, with the caller’s cutoff', async () => {
    vi.mocked(crossHome.resolveEntitlement).mockResolvedValue('entitled');
    const until = new Date();
    until.setHours(23, 59, 59, 999);
    const payload = {
      generatedAt: '2026-09-03T15:30:00.000Z',
      cutoff: until.toISOString(),
      households: [
        { householdId: 'hh-home', name: 'Home', role: 'admin', status: 'ok', tasks: [] },
        { householdId: 'hh-beach', name: null, role: 'member', status: 'unavailable' },
      ],
    };
    vi.mocked(crossHome.buildCrossHomeToday).mockResolvedValue(payload as never);

    const res = await myToday(
      buildEvent({ queryStringParameters: { until: until.toISOString() } }),
      ctx
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Cache-Control']).toBe('private, no-store');
    expect(JSON.parse(res.body)).toEqual(payload);
    expect(crossHome.resolveEntitlement).toHaveBeenCalledWith(MEMBERSHIPS);
    expect(crossHome.buildCrossHomeToday).toHaveBeenCalledWith(MEMBERSHIPS, until.toISOString());
  });

  it('defaults the cutoff to the end of the UTC day when the client sends none', async () => {
    vi.mocked(crossHome.resolveEntitlement).mockResolvedValue('entitled');
    vi.mocked(crossHome.buildCrossHomeToday).mockResolvedValue({
      generatedAt: '',
      cutoff: '',
      households: [],
    });
    await myToday(buildEvent(), ctx);
    const cutoff = vi.mocked(crossHome.buildCrossHomeToday).mock.calls[0][1];
    expect(cutoff).toMatch(/T23:59:59\.999Z$/);
  });

  it('is dispatched by the me router', async () => {
    const { handler } = await import('../../../src/handlers/me/handler.js');
    expect(handler.routes).toContain('GET /me/today');
  });
});
