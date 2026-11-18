/**
 * Audit 2026-11-08, finding 10: a sitter link revoked before its start date
 * blocked the away recap.
 *
 * The sibling suite (awayRecap.test.ts) mocks `listSitterWindowActivity`, so
 * nothing in it could see this defect: the failure lives in the range the
 * service hands DynamoDB. Here the handler, the link pick and the service are
 * all real, and the only fake is a DynamoDB that keeps the one rule that
 * matters, that BETWEEN refuses a lower bound above its upper bound.
 *
 * Before the fix the default request answered 500 for this household, and the
 * page showed "couldn't load" over a recap that was there to show.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/sitterService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

const ctx = {} as Context;
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

const memberClaims = {
  sub: 'user-2',
  email: 'm@b.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'member',
};

function event(linkId?: string): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/away-recap',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: linkId ? { linkId } : null,
    requestContext: {
      authorizer: { claims: memberClaims },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

function link(overrides: Record<string, unknown>) {
  return {
    token: null,
    keyToken: 'k'.repeat(64),
    householdId: 'hh-1',
    createdBy: 'u1',
    status: 'active',
    label: null,
    ...overrides,
  };
}

/** The trip that happened: opened a month ago, closed three weeks ago. */
const tookPlace = link({
  id: 'took-place',
  label: 'August trip',
  createdAt: at(-40),
  startsAt: at(-30),
  expiresAt: at(-21),
});
/** The trip that was called off: made yesterday for next week, then revoked. */
const calledOff = link({
  id: 'called-off',
  label: 'Next week',
  createdAt: at(-1),
  startsAt: at(7),
  expiresAt: at(14),
  status: 'revoked',
});

/** One sitter completion inside the real trip's window. */
const sitterRow = {
  entityType: 'ActivityEvent',
  id: 'e1',
  type: 'task.completed',
  householdId: 'hh-1',
  actorId: 'sitter:took-place',
  actorName: 'a plant sitter',
  occurredAt: at(-25),
  payload: { taskId: 't1', plantId: 'p1', plantName: 'Fern', taskType: 'water', viaSitter: true },
};

let queries: Array<{ from: string; to: string }>;

beforeEach(async () => {
  vi.clearAllMocks();
  queries = [];
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('user-2', 'hh-1', 'member');
  const billing = await import('../../../src/services/billing.js');
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);

  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockImplementation((async (command: {
    input: { ExpressionAttributeValues: Record<string, string> };
  }) => {
    const { ':from': from, ':to': to } = command.input.ExpressionAttributeValues;
    queries.push({ from, to });
    if (from > to) {
      throw Object.assign(
        new Error(
          'Invalid KeyConditionExpression: The BETWEEN operator requires upper bound to be greater than or equal to lower bound'
        ),
        { name: 'ValidationException' }
      );
    }
    return { Items: [sitterRow].filter((r) => r.occurredAt >= from && r.occurredAt <= to) };
  }) as never);
});

async function getRecap(links: unknown[], linkId?: string): Promise<APIGatewayProxyResult> {
  const sitterService = await import('../../../src/services/sitterService.js');
  vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce(links as never);
  const { getAwayRecap } = await import('../../../src/handlers/households/awayRecap.js');
  return (await getAwayRecap(event(linkId), ctx, () => {})) as APIGatewayProxyResult;
}

describe('away recap for a household with a link revoked before it started', () => {
  it('the fake DynamoDB keeps the BETWEEN rule this defect ran into', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    await expect(
      dynamodb.send({
        input: { ExpressionAttributeValues: { ':from': at(7), ':to': at(0) } },
      } as never)
    ).rejects.toMatchObject({ name: 'ValidationException' });
  });

  it('shows the recap of the trip that happened, not an error', async () => {
    const res = await getRecap([calledOff, tookPlace]);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.link).toMatchObject({ id: 'took-place', label: 'August trip', ended: true });
    expect(body.window).toEqual({ from: tookPlace.startsAt, to: tookPlace.expiresAt });
    expect(body.counts).toEqual({ tasks: 1, photos: 0, notes: 0 });
    expect(body.tasksCompleted[0]).toMatchObject({ plantName: 'Fern' });
    // Exactly one read, for the real window, and never a backwards range.
    expect(queries).toEqual([{ from: tookPlace.startsAt, to: tookPlace.expiresAt }]);
  });

  it('says no window has ended when the called-off link is all there is, and never an empty recap', async () => {
    const res = await getRecap([calledOff]);

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('No sitter window has ended yet');
    expect(body).not.toHaveProperty('tasksCompleted');
    expect(body).not.toHaveProperty('window');
    expect(body).not.toHaveProperty('counts');
    expect(queries).toEqual([]);
  });

  it('answers 404 for the called-off link asked for by id, with no recap and no read', async () => {
    const res = await getRecap([calledOff, tookPlace], 'called-off');

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('tasksCompleted');
    expect(queries).toEqual([]);
  });

  it('does the same for a link that is simply scheduled and not started', async () => {
    const scheduled = { ...calledOff, id: 'scheduled', status: 'active' };
    const byId = await getRecap([scheduled, tookPlace], 'scheduled');
    expect(byId.statusCode).toBe(404);
    const byDefault = await getRecap([scheduled, tookPlace]);
    expect(byDefault.statusCode).toBe(200);
    expect(JSON.parse(byDefault.body).link.id).toBe('took-place');
    expect(queries.every((q) => q.from <= q.to)).toBe(true);
  });
});
