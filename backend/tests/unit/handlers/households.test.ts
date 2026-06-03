import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/cognitoUsers.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));

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
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: claims ? { claims } : undefined,
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const fakeContext = {} as Context;

const adminClaims = {
  sub: 'user-1',
  email: 'a@b.com',
  'custom:household_id': 'hh-1',
  'custom:household_role': 'admin',
};
const memberClaims = { ...adminClaims, 'custom:household_role': 'member' };

describe('households handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The createInvite handler refuses to start without a base URL it can
    // hang invite codes off (FRONTEND_URL or ALLOWED_ORIGIN). In real envs
    // Terraform sets both; in tests pin a sentinel so url-shape assertions
    // are stable.
    process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
    process.env.ALLOWED_ORIGIN = 'https://test.familygreenhouse.net';
    // Activity recording is fire-and-forget (`.catch(...)`); the auto-mock
    // returns undefined, which would crash the chain. Make it return a
    // resolved promise so callers can keep chaining.
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
  });

  it('createHousehold allows a user with an existing household to create another (multi-household)', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    vi.mocked(householdService.createHousehold).mockResolvedValueOnce({
      id: 'hh-second',
      name: 'Vacation',
      createdAt: '',
      createdBy: 'user-1',
    });
    const event = buildEvent(adminClaims, {
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Vacation' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    // First-household-wins for the JWT default: a user who already has a
    // household keeps their original Cognito claim untouched.
    expect(cognitoUsers.setHouseholdClaims).not.toHaveBeenCalled();
  });

  it('createHousehold creates one and promotes user to admin via Cognito', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    vi.mocked(householdService.createHousehold).mockResolvedValueOnce({
      id: 'hh-new',
      name: 'Home',
      createdAt: '',
      createdBy: 'user-1',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    const event = buildEvent(
      { sub: 'user-1', email: 'a@b.com' },
      {
        httpMethod: 'POST',
        body: JSON.stringify({ name: 'Home' }),
        headers: { 'content-type': 'application/json' },
      }
    );
    const res = (await createHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    expect(householdService.createHousehold).toHaveBeenCalledWith(
      { name: 'Home' },
      'user-1',
      'Alice',
      'a@b.com'
    );
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-1', 'hh-new', 'admin');
  });

  it('getHousehold rejects cross-household access', async () => {
    const { getHousehold } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(adminClaims, { pathParameters: { id: 'hh-other' } });
    const res = (await getHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('getHousehold returns 404 when missing', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { getHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getHousehold).mockResolvedValueOnce(null);
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce([]);
    const event = buildEvent(adminClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('createInvite requires admin role', async () => {
    const { createInvite } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(memberClaims, {
      httpMethod: 'POST',
      pathParameters: { id: 'hh-1' },
    });
    const res = (await createInvite(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('createInvite returns invite payload with URL', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { createInvite } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.createInvite).mockResolvedValueOnce({
      code: 'ABC',
      householdId: 'hh-1',
      createdBy: 'user-1',
      createdAt: '',
      expiresAt: '2099-01-01',
    });
    const event = buildEvent(adminClaims, {
      httpMethod: 'POST',
      pathParameters: { id: 'hh-1' },
    });
    const res = (await createInvite(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ABC');
    expect(body.url).toContain('ABC');
  });

  it('validateInvite returns valid:false for unknown code', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { validateInvite } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getInvite).mockResolvedValueOnce(null);
    const res = (await validateInvite(
      buildEvent(null, { pathParameters: { inviteCode: 'NOPE' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).valid).toBe(false);
  });

  it('joinHousehold rejects already-in-household users', async () => {
    const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(adminClaims, {
      httpMethod: 'POST',
      pathParameters: { inviteCode: 'CODE' },
    });
    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('joinHousehold rejects invalid invite', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getInvite).mockResolvedValueOnce(null);
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );
    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('removeMember refuses self-removal', async () => {
    const { removeMember } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(adminClaims, {
      httpMethod: 'DELETE',
      pathParameters: { householdId: 'hh-1', userId: 'user-1' },
    });
    const res = (await removeMember(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('removeMember 404s when member not found', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const { removeMember } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    const event = buildEvent(adminClaims, {
      httpMethod: 'DELETE',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
    });
    const res = (await removeMember(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('removeMember clears Cognito household claims after removal', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const { removeMember } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member',
      joinedAt: '',
    });
    vi.mocked(householdService.removeMember).mockResolvedValueOnce(undefined);
    vi.mocked(cognitoUsers.clearHouseholdClaims).mockResolvedValueOnce(undefined);
    const event = buildEvent(adminClaims, {
      httpMethod: 'DELETE',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
    });
    const res = (await removeMember(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(cognitoUsers.clearHouseholdClaims).toHaveBeenCalledWith('user-2');
  });

  it('updateMemberRole refuses self-demotion', async () => {
    const { updateMemberRole } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(adminClaims, {
      httpMethod: 'PUT',
      pathParameters: { householdId: 'hh-1', userId: 'user-1' },
      body: JSON.stringify({ role: 'member' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await updateMemberRole(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('updateMemberRole writes role + Cognito claim', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const { updateMemberRole } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'B',
      email: 'b@b.com',
      role: 'member',
      joinedAt: '',
    });
    vi.mocked(householdService.setMemberRole).mockResolvedValueOnce({
      householdId: 'hh-1',
      userId: 'user-2',
      name: 'B',
      email: 'b@b.com',
      role: 'admin',
      joinedAt: '',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    const event = buildEvent(adminClaims, {
      httpMethod: 'PUT',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
      body: JSON.stringify({ role: 'admin' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await updateMemberRole(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-2', 'hh-1', 'admin');
  });

  it('getActivity blocks cross-household callers', async () => {
    const { getActivity } = await import('../../../src/handlers/households/handler.js');
    const event = buildEvent(adminClaims, { pathParameters: { id: 'hh-other' } });
    const res = (await getActivity(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('getActivity returns recent activity envelopes', async () => {
    const activity = await import('../../../src/services/activity.js');
    const { getActivity } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(activity.listActivity).mockResolvedValueOnce([
      {
        id: 'c1',
        type: 'task.completed',
        householdId: 'hh-1',
        actorId: 'u',
        actorName: 'A',
        occurredAt: '',
        payload: { plantId: 'p1', taskId: 't1', taskType: 'water', notes: null },
      },
    ]);
    const event = buildEvent(adminClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getActivity(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  it('joinHousehold sets member claims after adding to household', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getInvite).mockResolvedValueOnce({
      code: 'CODE',
      householdId: 'hh-9',
      createdBy: 'admin',
      createdAt: '',
      expiresAt: '2099-01-01',
    });
    vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
      id: 'hh-9',
      name: 'Home',
      createdAt: '',
      createdBy: 'admin',
    });
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Bob');
    vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce([]);
    vi.mocked(householdService.addMember).mockResolvedValueOnce({
      householdId: 'hh-9',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member',
      joinedAt: '',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );
    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-2', 'hh-9', 'member');
  });
});
