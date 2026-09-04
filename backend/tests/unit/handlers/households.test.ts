import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/welcomeEmail.js');
vi.mock('../../../src/services/inviteEmail.js', () => ({
  sendInviteEmail: vi.fn(async () => 'accepted'),
  DAILY_INVITE_EMAIL_CAP: 10,
}));
vi.mock('../../../src/services/householdEmails.js', () => ({
  notifyMemberJoined: vi.fn(async () => 1),
}));
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/activity.js');
vi.mock('../../../src/services/accountCleanup.js');
vi.mock('../../../src/services/cognitoUsers.js');
vi.mock('../../../src/services/sitterService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));
vi.mock('../../../src/services/escalation.js');

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
    const accountCleanup = await import('../../../src/services/accountCleanup.js');
    vi.mocked(accountCleanup.anonymizeUserInHousehold).mockResolvedValue(undefined);
    const householdService = await import('../../../src/services/householdService.js');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValue([]);
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

  it('createHousehold allows a user with an existing household to create another when a plan they hold includes more homes', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const billing = await import('../../../src/services/billing.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    // One existing home, on Greenhouse → unlimited homes (ADR 0014).
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
      { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'greenhouse' });
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

  describe('homes gate (ADR 0014: the one per-user cap)', () => {
    const membership = (householdId: string) => ({
      householdId,
      role: 'member' as const,
      name: 'Home',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });

    it('createHousehold refuses a second home with 402 when the strongest plan held is Garden', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const { createHousehold } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
      // Default billing mock = garden → 1 home.
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([membership('hh-1')]);
      const event = buildEvent(adminClaims, {
        httpMethod: 'POST',
        body: JSON.stringify({ name: 'Vacation' }),
        headers: { 'content-type': 'application/json' },
      });
      const res = (await createHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body).message).toBe(
        'Your Garden plan includes 1 home and you already belong to 1 household. Upgrade to Greenhouse for unlimited homes.'
      );
      expect(householdService.createHousehold).not.toHaveBeenCalled();
    });

    it('grandfathers a user already in three homes: every home still reads, only the fourth is refused', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const billing = await import('../../../src/services/billing.js');
      const { createHousehold, getHousehold } =
        await import('../../../src/handlers/households/handler.js');
      const three = [membership('hh-1'), membership('hh-2'), membership('hh-3')];
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValue(three);
      // All three on the free tier: over the cap of 1 from before the re-cut.
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' });

      // Reading an existing home is untouched by the gate.
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'user-1',
      });
      vi.mocked(householdService.getHouseholdMembersPublic).mockResolvedValueOnce([]);
      const read = (await getHousehold(
        buildEvent(adminClaims, { httpMethod: 'GET', pathParameters: { id: 'hh-1' } }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(read.statusCode).toBe(200);

      // The fourth is refused; nothing is removed to make room.
      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
      const res = (await createHousehold(
        buildEvent(adminClaims, {
          httpMethod: 'POST',
          body: JSON.stringify({ name: 'Fourth' }),
          headers: { 'content-type': 'application/json' },
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body).message).toMatch(/already belong to 3 households/);
      expect(householdService.createHousehold).not.toHaveBeenCalled();
      expect(householdService.removeMember).not.toHaveBeenCalled();

      vi.mocked(householdService.getMembershipsByUser).mockResolvedValue([]);
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' });
    });

    it('joinHousehold refuses a joiner who already has a home when the target is on Garden', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(householdService.getInvite).mockResolvedValueOnce({
        code: 'CODE',
        householdId: 'hh-target',
        createdBy: 'user-9',
        createdAt: '',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-target',
        name: 'Target',
        createdAt: '',
        createdBy: 'user-9',
      });
      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Bob');
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        membership('hh-mine'),
      ]);
      const event = buildEvent(
        { sub: 'user-2', email: 'b@b.com' },
        { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
      );
      const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body).message).toMatch(/includes 1 home/);
      expect(householdService.addMember).not.toHaveBeenCalled();
    });

    it('joinHousehold always admits a hand into a Greenhouse household, whatever the joiner already holds', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const billing = await import('../../../src/services/billing.js');
      const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(householdService.getInvite).mockResolvedValueOnce({
        code: 'CODE',
        householdId: 'hh-gh',
        createdBy: 'user-9',
        createdAt: '',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-gh',
        name: 'Clients',
        createdAt: '',
        createdBy: 'user-9',
      });
      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Bob');
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        membership('hh-a'),
        membership('hh-b'),
      ]);
      // The joined household is Greenhouse; the joiner's own two are free.
      vi.mocked(billing.getHouseholdSubscription).mockImplementation(async (id: string) => ({
        planId: id === 'hh-gh' ? 'greenhouse' : 'seedling',
      }));
      vi.mocked(householdService.addMember).mockResolvedValueOnce({
        householdId: 'hh-gh',
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
      // Unlimited members on Greenhouse: the cap handed to the service is null.
      expect(householdService.addMember).toHaveBeenCalledWith(
        'hh-gh',
        'user-2',
        'Bob',
        'b@b.com',
        null
      );
      vi.mocked(billing.getHouseholdSubscription).mockImplementation(async () => ({
        planId: 'garden',
      }));
    });
  });

  describe('analytics window (ADR 0014: free renders the trailing 30 days, nothing is deleted)', () => {
    it('clamps the daily series to 30 days on Seedling and says which window applied', async () => {
      const billing = await import('../../../src/services/billing.js');
      const taskService = await import('../../../src/services/taskService.js');
      const { getDailyAnalytics } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
      vi.mocked(taskService.getDailyCompletionCounts).mockResolvedValueOnce([]);
      const res = (await getDailyAnalytics(
        buildEvent(adminClaims, {
          httpMethod: 'GET',
          pathParameters: { id: 'hh-1' },
          queryStringParameters: { days: '180' },
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      // `doubleCare` is the neighbouring feature's field on this same
      // response: not_in_plan on Seedling, which has no household toolkit.
      expect(JSON.parse(res.body)).toEqual({
        days: 30,
        series: [],
        historyLimitDays: 30,
        doubleCare: { status: 'not_in_plan' },
      });
      expect(taskService.getDailyCompletionCounts).toHaveBeenCalledWith('hh-1', 30);
    });

    it('serves the full requested range on Garden with historyLimitDays null (no limit, not unknown)', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { getDailyAnalytics } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(taskService.getDailyCompletionCounts).mockResolvedValueOnce([]);
      const res = (await getDailyAnalytics(
        buildEvent(adminClaims, {
          httpMethod: 'GET',
          pathParameters: { id: 'hh-1' },
          queryStringParameters: { days: '180' },
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      // Garden HAS the toolkit, so the roll-up is attempted; the service is
      // unmocked here and reports its own explicit absence rather than a 0.
      expect(JSON.parse(res.body)).toEqual({
        days: 180,
        series: [],
        historyLimitDays: null,
        doubleCare: { status: 'unavailable' },
      });
      expect(taskService.getDailyCompletionCounts).toHaveBeenCalledWith('hh-1', 180);
    });

    it('windows the year-in-review on Seedling to the trailing 30 days of that year, never trimming rows', async () => {
      const billing = await import('../../../src/services/billing.js');
      const taskService = await import('../../../src/services/taskService.js');
      const { getYearInReview } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
      vi.mocked(taskService.getCompletionReview).mockResolvedValueOnce({
        totalCompletions: 2,
        byMember: [],
        byTaskType: [],
        topPlants: [],
      });
      const year = new Date().getFullYear();
      const res = (await getYearInReview(
        buildEvent(adminClaims, {
          httpMethod: 'GET',
          pathParameters: { id: 'hh-1' },
          queryStringParameters: { year: String(year) },
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ year, totalCompletions: 2, historyLimitDays: 30 });
      expect(typeof body.windowStart).toBe('string');
      expect(typeof body.windowEnd).toBe('string');
      // The window is a read range, not a mutation: the year-shaped query is
      // simply not used, and nothing else is called.
      const [, start, end] = vi.mocked(taskService.getCompletionReview).mock.calls[0];
      expect(new Date(end).getTime() - new Date(start).getTime()).toBeLessThanOrEqual(
        30 * 24 * 60 * 60 * 1000
      );
      expect(taskService.getYearInReview).not.toHaveBeenCalled();
    });

    it('serves the whole year on Garden', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const { getYearInReview } = await import('../../../src/handlers/households/handler.js');
      vi.mocked(taskService.getYearInReview).mockResolvedValueOnce({
        year: 2026,
        totalCompletions: 9,
        byMember: [],
        byTaskType: [],
        topPlants: [],
      });
      const res = (await getYearInReview(
        buildEvent(adminClaims, {
          httpMethod: 'GET',
          pathParameters: { id: 'hh-1' },
          queryStringParameters: { year: '2026' },
        }),
        fakeContext,
        () => {}
      )) as APIGatewayProxyResult;
      expect(JSON.parse(res.body)).toEqual({
        year: 2026,
        totalCompletions: 9,
        byMember: [],
        byTaskType: [],
        topPlants: [],
        historyLimitDays: null,
      });
      expect(taskService.getCompletionReview).not.toHaveBeenCalled();
    });
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

  it('repairs a missing default claim from membership state without creating a duplicate', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const welcomeEmail = await import('../../../src/services/welcomeEmail.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Alice');
    vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
      { householdId: 'hh-first', role: 'admin', name: 'Alice', joinedAt: '' },
    ]);
    vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
      id: 'hh-first',
      name: 'Home',
      createdAt: '',
      createdBy: 'user-1',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims).mockResolvedValueOnce(undefined);
    vi.mocked(welcomeEmail.sendWelcomeEmail).mockResolvedValueOnce(false);

    const res = (await createHousehold(
      buildEvent(
        { sub: 'user-1', email: 'a@b.com' },
        {
          httpMethod: 'POST',
          body: JSON.stringify({ name: 'Vacation' }),
          headers: { 'content-type': 'application/json' },
        }
      ),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'hh-first', name: 'Home' });
    expect(householdService.createHousehold).not.toHaveBeenCalled();
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-1', 'hh-first', 'admin');
    expect(welcomeEmail.sendWelcomeEmail).toHaveBeenCalledOnce();
  });

  it('retries claim repair after a partial first-household write without creating twice', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const welcomeEmail = await import('../../../src/services/welcomeEmail.js');
    const { createHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValue('Alice');
    vi.mocked(householdService.getMembershipsByUser)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          householdId: 'hh-first',
          role: 'admin',
          name: 'Alice',
          joinedAt: '2026-07-25T12:00:00Z',
        },
      ]);
    vi.mocked(householdService.createHousehold).mockResolvedValueOnce({
      id: 'hh-first',
      name: 'Home',
      createdAt: '2026-07-25T12:00:00Z',
      createdBy: 'user-1',
    });
    vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
      id: 'hh-first',
      name: 'Home',
      createdAt: '2026-07-25T12:00:00Z',
      createdBy: 'user-1',
    });
    vi.mocked(cognitoUsers.setHouseholdClaims)
      .mockRejectedValueOnce(new Error('Cognito timeout after DynamoDB commit'))
      .mockResolvedValueOnce(undefined);
    vi.mocked(welcomeEmail.sendWelcomeEmail).mockResolvedValueOnce(true);
    const event = () =>
      buildEvent(
        { sub: 'user-1', email: 'a@b.com' },
        {
          httpMethod: 'POST',
          body: JSON.stringify({ name: 'Home' }),
          headers: { 'content-type': 'application/json' },
        }
      );

    const first = (await createHousehold(event(), fakeContext, () => {})) as APIGatewayProxyResult;
    const retry = (await createHousehold(event(), fakeContext, () => {})) as APIGatewayProxyResult;

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(retry.body).id).toBe('hh-first');
    expect(householdService.createHousehold).toHaveBeenCalledOnce();
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledTimes(2);
    expect(welcomeEmail.sendWelcomeEmail).toHaveBeenCalledOnce();
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
    // Simulate the worst case: the welcome send rejects despite the service's
    // best-effort contract. The handler awaits it for Lambda reliability but
    // still isolates the failure, so the 201 comes back.
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
    vi.mocked(householdService.getHouseholdMembersPublic).mockResolvedValueOnce([]);
    const event = buildEvent(adminClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });

  it('getHousehold never includes member email, even for a non-admin caller', async () => {
    // The bug: requireHousehold() has no admin check on this route, so a
    // plain member reaches the handler — and the roster used to come back
    // with everyone's email regardless of role.
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
    const householdService = await import('../../../src/services/householdService.js');
    const { getHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
      id: 'hh-1',
      name: 'Home',
      createdAt: '',
      createdBy: 'user-1',
    });
    vi.mocked(householdService.getHouseholdMembersPublic).mockResolvedValueOnce([
      { householdId: 'hh-1', userId: 'user-1', name: 'Alice', role: 'member', joinedAt: '' },
      { householdId: 'hh-1', userId: 'user-2', name: 'Bob', role: 'admin', joinedAt: '' },
    ]);
    const event = buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } });
    const res = (await getHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    // The safe, email-stripping function is what the handler must call —
    // never the shared getHouseholdMembers (which keeps email for the
    // legitimate internal callers, e.g. reminders/digest outbound mail).
    expect(householdService.getHouseholdMembersPublic).toHaveBeenCalledWith('hh-1');
    expect(householdService.getHouseholdMembers).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    for (const member of body.members) {
      expect(member).not.toHaveProperty('email');
    }
    expect(JSON.stringify(body)).not.toMatch(/email/i);
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

  // --- POST /households/:id/invites/email ---------------------------------

  /** The two identity reads the email path refuses to send without. */
  async function mockInviteIdentity(
    overrides: { inviterName?: string | null; householdName?: string | null } = {}
  ) {
    const householdService = await import('../../../src/services/householdService.js');
    const { inviterName = 'Sam', householdName = 'The Kim House' } = overrides;
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue(
      inviterName === null
        ? null
        : {
            householdId: 'hh-1',
            userId: 'user-1',
            name: inviterName,
            email: 'a@b.com',
            role: 'admin',
            joinedAt: '',
          }
    );
    vi.mocked(householdService.getHousehold).mockResolvedValue(
      householdName === null
        ? null
        : { id: 'hh-1', name: householdName, createdAt: '', createdBy: 'user-1' }
    );
    vi.mocked(householdService.createInvite).mockResolvedValue({
      code: 'ABC',
      householdId: 'hh-1',
      createdBy: 'user-1',
      createdAt: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  }

  function emailInviteEvent(body: unknown, claims = adminClaims) {
    return buildEvent(claims, {
      httpMethod: 'POST',
      pathParameters: { id: 'hh-1' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('emailInvite sends the invitation and returns the link alongside the status', async () => {
    await mockInviteIdentity();
    const inviteEmail = await import('../../../src/services/inviteEmail.js');
    const { emailInvite } = await import('../../../src/handlers/households/handler.js');

    const res = (await emailInvite(
      emailInviteEvent({ email: 'friend@example.com', locale: 'es' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('accepted');
    // The link always comes back so the UI can fall back to copy-and-paste.
    expect(body.url).toContain('ABC');
    expect(inviteEmail.sendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'friend@example.com',
        inviterName: 'Sam',
        householdName: 'The Kim House',
        locale: 'es',
      })
    );
  });

  it('emailInvite requires admin role', async () => {
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
    await mockInviteIdentity();
    const { emailInvite } = await import('../../../src/handlers/households/handler.js');
    const res = (await emailInvite(
      emailInviteEvent({ email: 'friend@example.com' }, memberClaims),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('emailInvite rejects a body that is not an email address', async () => {
    await mockInviteIdentity();
    const { emailInvite } = await import('../../../src/handlers/households/handler.js');
    const res = (await emailInvite(
      emailInviteEvent({ email: 'not-an-address' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });

  it('emailInvite mints no invite code when it cannot name the sender', async () => {
    // An invite that cannot say who it is from is the shape we refuse, and a
    // refused invite must not leave a live code behind.
    await mockInviteIdentity({ inviterName: null });
    const householdService = await import('../../../src/services/householdService.js');
    const inviteEmail = await import('../../../src/services/inviteEmail.js');
    const { emailInvite } = await import('../../../src/handlers/households/handler.js');

    const res = (await emailInvite(
      emailInviteEvent({ email: 'friend@example.com' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(503);
    expect(householdService.createInvite).not.toHaveBeenCalled();
    expect(inviteEmail.sendInviteEmail).not.toHaveBeenCalled();
  });

  it('emailInvite answers 429 when the household has spent its daily allowance', async () => {
    await mockInviteIdentity();
    const inviteEmail = await import('../../../src/services/inviteEmail.js');
    vi.mocked(inviteEmail.sendInviteEmail).mockResolvedValueOnce('rate_limited');
    const { emailInvite } = await import('../../../src/handlers/households/handler.js');

    const res = (await emailInvite(
      emailInviteEvent({ email: 'friend@example.com' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(429);
  });

  it('emailInvite never claims a send that did not happen', async () => {
    await mockInviteIdentity();
    const inviteEmail = await import('../../../src/services/inviteEmail.js');
    vi.mocked(inviteEmail.sendInviteEmail).mockResolvedValueOnce('unavailable');
    const { emailInvite } = await import('../../../src/handlers/households/handler.js');

    const res = (await emailInvite(
      emailInviteEvent({ email: 'friend@example.com' }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    const body = JSON.parse(res.body);
    expect(body.status).toBe('unavailable');
    expect(body.url).toContain('ABC');
  });

  it('joinHousehold tells the household, naming whoever minted the invite', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const householdEmails = await import('../../../src/services/householdEmails.js');
    const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getInvite).mockResolvedValueOnce({
      code: 'CODE',
      householdId: 'hh-9',
      createdBy: 'inviter-1',
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
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );

    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(householdEmails.notifyMemberJoined).toHaveBeenCalledWith({
      householdId: 'hh-9',
      joinedUserId: 'user-2',
      invitedBy: 'inviter-1',
    });
  });

  it('joinHousehold still succeeds when the join email cannot be queued', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const householdEmails = await import('../../../src/services/householdEmails.js');
    vi.mocked(householdEmails.notifyMemberJoined).mockRejectedValueOnce(new Error('ddb down'));
    const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
    vi.mocked(householdService.getInvite).mockResolvedValueOnce({
      code: 'CODE',
      householdId: 'hh-9',
      createdBy: 'inviter-1',
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
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );

    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
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
    const accountCleanup = await import('../../../src/services/accountCleanup.js');
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
    expect(accountCleanup.anonymizeUserInHousehold).toHaveBeenCalledWith('hh-1', 'user-2');
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
    // Seedling: Garden and Greenhouse have no member cap to lose (ADR 0014).
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' });
    vi.mocked(householdService.addMember).mockRejectedValueOnce(
      Object.assign(new Error('Member limit of 3 reached'), { name: 'PlanLimitError' })
    );
    const event = buildEvent(
      { sub: 'user-2', email: 'b@b.com' },
      { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
    );
    const res = (await joinHousehold(event, fakeContext, () => {})) as APIGatewayProxyResult;
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' });
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatch(/Seedling plan, limited to 3 members/);
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
    // the plan's member limit down (default billing mock = garden, whose
    // member cap is `null`/unlimited per ADR 0014) and no longer pre-counts
    // member rows.
    expect(householdService.addMember).toHaveBeenCalledWith(
      'hh-9',
      'user-2',
      'Bob',
      'b@b.com',
      null
    );
    // The roster IS read after the join now, to address the "someone joined
    // your household" email (#431). What must not come back is the pre-count
    // the cap used to depend on, so this asserts ordering rather than
    // absence: any roster read happens strictly after addMember.
    const addMemberOrder = vi.mocked(householdService.addMember).mock.invocationCallOrder[0];
    for (const order of vi.mocked(householdService.getHouseholdMembers).mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(addMemberOrder);
    }
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledWith('user-2', 'hh-9', 'member');
  });

  it('joinHousehold repairs Cognito claims on retry after the member write committed', async () => {
    const householdService = await import('../../../src/services/householdService.js');
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    const { joinHousehold } = await import('../../../src/handlers/households/handler.js');
    const invite = {
      code: 'CODE',
      householdId: 'hh-9',
      createdBy: 'admin',
      createdAt: '',
      expiresAt: '2099-01-01',
    };
    const household = {
      id: 'hh-9',
      name: 'Home',
      createdAt: '',
      createdBy: 'admin',
    };
    const member = {
      householdId: 'hh-9',
      userId: 'user-2',
      name: 'Bob',
      email: 'b@b.com',
      role: 'member' as const,
      joinedAt: '',
    };
    vi.mocked(householdService.getInvite).mockResolvedValue(invite);
    vi.mocked(householdService.getHousehold).mockResolvedValue(household);
    vi.mocked(cognitoUsers.getUserName).mockResolvedValue('Bob');
    vi.mocked(householdService.getMemberByUserId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(member);
    vi.mocked(householdService.addMember).mockResolvedValueOnce(member);
    vi.mocked(cognitoUsers.setHouseholdClaims)
      .mockRejectedValueOnce(new Error('Cognito timeout after DynamoDB commit'))
      .mockResolvedValueOnce(undefined);
    const event = () =>
      buildEvent(
        { sub: 'user-2', email: 'b@b.com' },
        { httpMethod: 'POST', pathParameters: { inviteCode: 'CODE' } }
      );

    const first = (await joinHousehold(event(), fakeContext, () => {})) as APIGatewayProxyResult;
    const retry = (await joinHousehold(event(), fakeContext, () => {})) as APIGatewayProxyResult;

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body)).toMatchObject({ id: 'hh-9', name: 'Home' });
    expect(householdService.addMember).toHaveBeenCalledOnce();
    expect(cognitoUsers.setHouseholdClaims).toHaveBeenCalledTimes(2);
  });
});

describe('households handler — PUT /households/{id}/escalation (ADR 0018)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Same membership/rate-limit reset as the main block: this describe is a
    // sibling, so it must warm the admin caller itself.
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'admin');
  });

  function escalationEvent(claims: Record<string, unknown>, body: unknown, id = 'hh-1') {
    return buildEvent(claims, {
      httpMethod: 'PUT',
      pathParameters: { id },
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('stores a valid rule for an admin on a toolkit plan', async () => {
    const escalation = await import('../../../src/services/escalation.js');
    vi.mocked(escalation.setEscalationRule).mockResolvedValueOnce(7);
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(adminClaims, { escalateAfterDays: 7 }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ escalateAfterDays: 7 });
    expect(escalation.setEscalationRule).toHaveBeenCalledWith('hh-1', 7);
  });

  it('clears the rule with null', async () => {
    const escalation = await import('../../../src/services/escalation.js');
    vi.mocked(escalation.setEscalationRule).mockResolvedValueOnce(null);
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(adminClaims, { escalateAfterDays: null }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(escalation.setEscalationRule).toHaveBeenCalledWith('hh-1', null);
  });

  it('enforces the 5-day floor at the edge (400) before touching the service', async () => {
    const escalation = await import('../../../src/services/escalation.js');
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(adminClaims, { escalateAfterDays: 4 }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(escalation.setEscalationRule).not.toHaveBeenCalled();
  });

  it('is admin-only (403 for a member)', async () => {
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
    const escalation = await import('../../../src/services/escalation.js');
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(memberClaims, { escalateAfterDays: 7 }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
    expect(escalation.setEscalationRule).not.toHaveBeenCalled();
  });

  it('is plan-gated: 402 without the household toolkit, and nothing is stored', async () => {
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
    } as never);
    const escalation = await import('../../../src/services/escalation.js');
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(adminClaims, { escalateAfterDays: 7 }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).message).toMatch(/household toolkit/);
    expect(escalation.setEscalationRule).not.toHaveBeenCalled();
  });

  it('refuses another household’s id (403)', async () => {
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(adminClaims, { escalateAfterDays: 7 }, 'hh-other'),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
  });

  it('maps the service range error to 400 (defence in depth)', async () => {
    const escalation = await import('../../../src/services/escalation.js');
    vi.mocked(escalation.setEscalationRule).mockRejectedValueOnce(
      Object.assign(new Error('too low'), { name: 'EscalationRuleRangeError' })
    );
    const { setEscalationRule } = await import('../../../src/handlers/households/handler.js');
    const res = (await setEscalationRule(
      escalationEvent(adminClaims, { escalateAfterDays: 7 }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Sitter links are open to every household member (ADR 0015), not only
 * admins. The revocation model keeps that safe: an admin may revoke any of
 * the household's links, a member only the ones they created, and every
 * create/revoke is an activity event that names the actor.
 */
describe('sitter links — member access and revocation model', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const link = (overrides: Record<string, unknown> = {}) => ({
    id: 'link-1',
    token: 'a'.repeat(64),
    householdId: 'hh-1',
    createdBy: 'user-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    startsAt: '2026-09-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    status: 'active',
    label: 'Holiday plants',
    ...overrides,
  });

  async function warm(role: 'admin' | 'member') {
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', role);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
    const activity = await import('../../../src/services/activity.js');
    vi.mocked(activity.recordActivity).mockResolvedValue(undefined);
    const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(cognitoUsers.getUserName).mockResolvedValue('Chelsea');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.toSummary).mockImplementation((l) => {
      const { token: _token, ...rest } = l as never as Record<string, unknown>;
      void _token;
      return rest as never;
    });
    vi.mocked(sitterService.listSitterLinks).mockResolvedValue([]);
    vi.mocked(sitterService.createSitterLink).mockResolvedValue(link() as never);
    vi.mocked(sitterService.revokeSitterLink).mockResolvedValue(true);
  });

  it('lets a plain member create a link and names them in the activity feed', async () => {
    await warm('member');
    const { createSitterLink } = await import('../../../src/handlers/households/handler.js');
    const activity = await import('../../../src/services/activity.js');
    const res = (await createSitterLink(
      buildEvent(memberClaims, {
        httpMethod: 'POST',
        pathParameters: { id: 'hh-1' },
        body: JSON.stringify({
          expiresAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
          label: 'Holiday plants',
        }),
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).url).toContain('/sit/');
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sitter_link.created',
        householdId: 'hh-1',
        actorId: 'user-1',
        actorName: 'Chelsea',
        payload: expect.objectContaining({ linkId: 'link-1', label: 'Holiday plants' }),
      })
    );
    // The token never rides along in the activity payload.
    const call = vi.mocked(activity.recordActivity).mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain('a'.repeat(64));
  });

  it('refuses (402) an over-cap window on Seedling and names what Garden lifts it to', async () => {
    await warm('member');
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
    } as never);
    const sitterService = await import('../../../src/services/sitterService.js');
    const { createSitterLink } = await import('../../../src/handlers/households/handler.js');
    const res = (await createSitterLink(
      buildEvent(memberClaims, {
        httpMethod: 'POST',
        pathParameters: { id: 'hh-1' },
        body: JSON.stringify({ expiresAt: new Date(Date.now() + 8 * DAY_MS).toISOString() }),
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).message).toMatch(/up to 7 days.*Garden allows up to 90 days/);
    expect(sitterService.createSitterLink).not.toHaveBeenCalled();
  });

  it('refuses (402) a second live link on Seedling; ended and revoked rows do not count', async () => {
    await warm('admin');
    const billing = await import('../../../src/services/billing.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'seedling' } as never);
    const sitterService = await import('../../../src/services/sitterService.js');
    const { createSitterLink } = await import('../../../src/handlers/households/handler.js');
    const attempt = () =>
      createSitterLink(
        buildEvent(adminClaims, {
          httpMethod: 'POST',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ expiresAt: new Date(Date.now() + 3 * DAY_MS).toISOString() }),
        }),
        fakeContext,
        () => {}
      ) as Promise<APIGatewayProxyResult>;

    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([link() as never]);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(402);
    expect(JSON.parse(blocked.body).message).toMatch(/1 live sitter link at a time/);

    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([
      link({ id: 'old', expiresAt: new Date(Date.now() - DAY_MS).toISOString() }) as never,
      link({ id: 'off', status: 'revoked' }) as never,
    ]);
    const allowed = await attempt();
    expect(allowed.statusCode).toBe(201);
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' } as never);
  });

  it('allows a 30-day window with several live links on Garden', async () => {
    await warm('member');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([
      link({ id: 'l1' }) as never,
      link({ id: 'l2' }) as never,
    ]);
    const { createSitterLink } = await import('../../../src/handlers/households/handler.js');
    const res = (await createSitterLink(
      buildEvent(memberClaims, {
        httpMethod: 'POST',
        pathParameters: { id: 'hh-1' },
        body: JSON.stringify({ expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString() }),
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
  });

  it('rejects (400) a window past the 90-day ceiling before the plan is even consulted', async () => {
    await warm('member');
    const billing = await import('../../../src/services/billing.js');
    const { createSitterLink } = await import('../../../src/handlers/households/handler.js');
    const res = (await createSitterLink(
      buildEvent(memberClaims, {
        httpMethod: 'POST',
        pathParameters: { id: 'hh-1' },
        body: JSON.stringify({ expiresAt: new Date(Date.now() + 120 * DAY_MS).toISOString() }),
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
  });

  it('lets a plain member list the household links', async () => {
    await warm('member');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.listSitterLinks).mockResolvedValueOnce([link() as never]);
    const { listSitterLinks } = await import('../../../src/handlers/households/handler.js');
    const res = (await listSitterLinks(
      buildEvent(memberClaims, { pathParameters: { id: 'hh-1' } }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
    expect(res.body).not.toContain('a'.repeat(64));
  });

  it('lets a member revoke a link they created, and records it', async () => {
    await warm('member');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.findSitterLink).mockResolvedValueOnce(link() as never);
    const { revokeSitterLink } = await import('../../../src/handlers/households/handler.js');
    const activity = await import('../../../src/services/activity.js');
    const res = (await revokeSitterLink(
      buildEvent(memberClaims, {
        httpMethod: 'DELETE',
        pathParameters: { id: 'hh-1', linkId: 'link-1' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(sitterService.revokeSitterLink).toHaveBeenCalledWith('hh-1', 'link-1');
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sitter_link.revoked', actorName: 'Chelsea' })
    );
  });

  it("refuses (403) a member revoking another member's link, without touching it", async () => {
    await warm('member');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.findSitterLink).mockResolvedValueOnce(
      link({ createdBy: 'user-2' }) as never
    );
    const { revokeSitterLink } = await import('../../../src/handlers/households/handler.js');
    const res = (await revokeSitterLink(
      buildEvent(memberClaims, {
        httpMethod: 'DELETE',
        pathParameters: { id: 'hh-1', linkId: 'link-1' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(403);
    expect(sitterService.revokeSitterLink).not.toHaveBeenCalled();
  });

  it("lets an admin revoke any member's link", async () => {
    await warm('admin');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.findSitterLink).mockResolvedValueOnce(
      link({ createdBy: 'user-2' }) as never
    );
    const { revokeSitterLink } = await import('../../../src/handlers/households/handler.js');
    const res = (await revokeSitterLink(
      buildEvent(adminClaims, {
        httpMethod: 'DELETE',
        pathParameters: { id: 'hh-1', linkId: 'link-1' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(204);
    expect(sitterService.revokeSitterLink).toHaveBeenCalledWith('hh-1', 'link-1');
  });

  it('404s revoking a link the household does not have', async () => {
    await warm('admin');
    const sitterService = await import('../../../src/services/sitterService.js');
    vi.mocked(sitterService.findSitterLink).mockResolvedValueOnce(null);
    const { revokeSitterLink } = await import('../../../src/handlers/households/handler.js');
    const res = (await revokeSitterLink(
      buildEvent(adminClaims, {
        httpMethod: 'DELETE',
        pathParameters: { id: 'hh-1', linkId: 'nope' },
      }),
      fakeContext,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(404);
  });
});
