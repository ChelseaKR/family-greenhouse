import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/welcomeEmail.js');
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
    // authMiddleware now validates the claim household against the
    // membership table. Pre-warm the cache for the default admin caller so
    // per-test `getMemberByUserId` Once-mocks stay reserved for the
    // handlers' own target-member lookups. Tests that need a non-admin
    // caller re-warm with role 'member'.
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'admin');
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

  it('createHousehold sends exactly one welcome email on the genuine first household', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const welcomeEmail = await import('../../../src/services/welcomeEmail.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    vi.mocked(householdService.createHousehold).mockResolvedValueOnce({
      id: 'hh-new',
      name: 'Home',
      createdAt: '',
      createdBy: 'user-1',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    vi.mocked(welcomeEmail.sendWelcomeEmail).mockResolvedValueOnce(true);
    // No `custom:household_id` claim ⇒ this is the user's first household.
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
    expect(welcomeEmail.sendWelcomeEmail).toHaveBeenCalledTimes(1);
    expect(welcomeEmail.sendWelcomeEmail).toHaveBeenCalledWith(
      'user-1',
      'a@b.com',
      'Alice',
      'https://test.familygreenhouse.net'
    );
  });

  it('createHousehold does NOT welcome again when the user already has a household', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const welcomeEmail = await import('../../../src/services/welcomeEmail.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    vi.mocked(householdService.createHousehold).mockResolvedValueOnce({
      id: 'hh-second',
      name: 'Vacation',
      createdAt: '',
      createdBy: 'user-1',
    });
    // adminClaims carries an existing household_id ⇒ "add another household".
    const event = buildEvent(adminClaims, {
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Vacation' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await createHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    expect(welcomeEmail.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('createHousehold still succeeds (non-blocking) when the welcome email fails', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const welcomeEmail = await import('../../../src/services/welcomeEmail.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    vi.mocked(householdService.createHousehold).mockResolvedValueOnce({
      id: 'hh-new',
      name: 'Home',
      createdAt: '',
      createdBy: 'user-1',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    // Simulate the worst case: the welcome send rejects. Onboarding must not
    // observe it — the handler fires it without awaiting and the service
    // swallows its own errors, so the 201 still comes back.
    vi.mocked(welcomeEmail.sendWelcomeEmail).mockRejectedValueOnce(new Error('SES down'));
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
    expect(welcomeEmail.sendWelcomeEmail).toHaveBeenCalledTimes(1);
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
    // The membership row (here: the warmed cache) is authoritative for the
    // caller's role — re-warm as a plain member.
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
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

  it('removeMember clears claims when removed from the claim household with no other memberships', async () => {
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
    // hh-1 IS user-2's claim household, and they have no other memberships.
    vi.mocked(cognitoUsers.getHouseholdClaims).mockResolvedValueOnce({
      householdId: 'hh-1',
      role: 'member',
    });
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([]);
    vi.mocked(cognitoUsers.clearHouseholdClaims).mockResolvedValueOnce(undefined);
    const event = buildEvent(adminClaims, {
      httpMethod: 'DELETE',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
    });
    const res = (await removeMember(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(cognitoUsers.clearHouseholdClaims).toHaveBeenCalledWith('user-2');
    expect(cognitoUsers.setHouseholdClaims).not.toHaveBeenCalled();
  });

  it('removeMember on a SECONDARY household preserves the claim household untouched', async () => {
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
    // user-2's claim household is hh-OTHER; being removed from hh-1 must not
    // log them out of hh-OTHER (the pre-fix bug: unconditional clear).
    vi.mocked(cognitoUsers.getHouseholdClaims).mockResolvedValueOnce({
      householdId: 'hh-other',
      role: 'admin',
    });
    const event = buildEvent(adminClaims, {
      httpMethod: 'DELETE',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
    });
    const res = (await removeMember(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(cognitoUsers.clearHouseholdClaims).not.toHaveBeenCalled();
    expect(cognitoUsers.setHouseholdClaims).not.toHaveBeenCalled();
    expect(householdService.getMembershipsByUser).not.toHaveBeenCalled();
  });

  it('removeMember from the claim household re-points claims at a remaining membership', async () => {
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
    vi.mocked(cognitoUsers.getHouseholdClaims).mockResolvedValueOnce({
      householdId: 'hh-1',
      role: 'member',
    });
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
      { householdId: 'hh-2', role: 'admin', name: 'Cabin', joinedAt: '' },
    ]);
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    const event = buildEvent(adminClaims, {
      httpMethod: 'DELETE',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
    });
    const res = (await removeMember(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-2', 'hh-2', 'admin');
    expect(cognitoUsers.clearHouseholdClaims).not.toHaveBeenCalled();
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

  it('updateMemberRole writes role + Cognito claim when this is the claim household', async () => {
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
    vi.mocked(cognitoUsers.getHouseholdClaims).mockResolvedValueOnce({
      householdId: 'hh-1',
      role: 'member',
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

  it('updateMemberRole does NOT rewrite claims when the target claims a different household', async () => {
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
    // user-2's default household is hh-other: a role change in hh-1 must not
    // hijack their default household (the pre-fix bug: unconditional set).
    vi.mocked(cognitoUsers.getHouseholdClaims).mockResolvedValueOnce({
      householdId: 'hh-other',
      role: 'member',
    });
    const event = buildEvent(adminClaims, {
      httpMethod: 'PUT',
      pathParameters: { householdId: 'hh-1', userId: 'user-2' },
      body: JSON.stringify({ role: 'admin' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = (await updateMemberRole(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(cognitoUsers.setHouseholdClaims).not.toHaveBeenCalled();
  });

  it('joinHousehold maps the addMember conditional-write race to "already a member"', async () => {
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
    // Pre-check sees no member row…
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    // …but a concurrent join wins the transacted conditional Put (the
    // service surfaces the member-row CancellationReason under the
    // long-established ConditionalCheckFailedException name).
    vi.mocked(householdService.addMember).mockRejectedValueOnce(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' })
    );
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );
    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/already a member/i);
    expect(cognitoUsers.setHouseholdClaims).not.toHaveBeenCalled();
  });

  it('joinHousehold returns 402 (not 400) when the transacted member cap loses', async () => {
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
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
    // The memberCount increment lost against the plan cap inside the
    // service's TransactWriteCommand (e.g. a concurrent join took the last
    // Garden slot) — distinguishable from duplicate-join by error name.
    vi.mocked(householdService.addMember).mockRejectedValueOnce(
      Object.assign(new Error('Member limit of 6 reached'), { name: 'PlanLimitError' })
    );
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );
    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatch(/Garden plan, limited to 6 members/);
    expect(cognitoUsers.setHouseholdClaims).not.toHaveBeenCalled();
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
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
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
    // Cap enforcement moved into the service transaction — the handler hands
    // the plan's maxMembers down (default billing mock = garden → 6) and no
    // longer pre-counts member rows.
    expect(householdService.addMember).toHaveBeenCalledWith('hh-9', 'user-2', 'Bob', 'b@b.com', 6);
    expect(householdService.getHouseholdMembers).not.toHaveBeenCalled();
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-2', 'hh-9', 'member');
  });
});
