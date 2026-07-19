import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

// Cognito + helper service mocks: the auth handler is thin over Cognito, so
// these tests assert the request shape we send + the HTTP errors we surface
// for known Cognito exception names. We don't run JWT decode logic — the
// authMiddleware on getMe/changePassword/updateProfile is unit-tested
// separately under tests/unit/middleware/auth.test.ts.
vi.mock('../../../src/utils/cognito.js', () => ({
  cognito: { send: vi.fn() },
  CLIENT_ID: 'test-client-id',
}));
vi.mock('../../../src/services/cognitoUsers.js', () => ({
  getUserName: vi.fn(),
}));
vi.mock('../../../src/services/householdService.js', () => ({
  updateMemberNameAcrossHouseholds: vi.fn(),
}));
const commercialStatus = vi.hoisted(() => ({ registrationAvailable: true }));
vi.mock('../../../src/config/commercialStatus.js', () => ({
  publicRegistrationIsAvailable: () => commercialStatus.registrationAvailable,
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
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
          email: 'test@example.com',
          name: 'Test User',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

class CognitoError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

describe('auth handler', () => {
  beforeEach(async () => {
    // `clearAllMocks` only resets call history; any unconsumed
    // `mockResolvedValueOnce` / `mockRejectedValueOnce` queued by a
    // previous test would carry over into the next one and cause
    // confusing test-cross-talk (a `signup` test queuing an exception
    // that gets consumed by the next `login` test). `resetAllMocks`
    // additionally drops the implementations, so each test starts from
    // a clean Cognito mock.
    vi.resetAllMocks();
    commercialStatus.registrationAvailable = true;
    // The rate limiter holds in-memory buckets keyed by IP+path. Tests
    // share an IP (127.0.0.1) and route, so without resetting between
    // tests the 11th call would 429 even though the test suite is
    // intentionally simulating fresh requests.
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
    // authMiddleware validates the claim household against the membership
    // table; pre-warm the cache so the partial householdService mock (which
    // doesn't implement getMemberByUserId) never gets consulted for it.
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'admin');
  });

  describe('signup', () => {
    it('returns 503 before Cognito when registration is explicitly paused', async () => {
      commercialStatus.registrationAvailable = false;
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { signup } = await import('../../../src/handlers/auth/handler.js');

      const res = (await signup(
        buildEvent({
          body: JSON.stringify({
            email: 'new@example.com',
            password: 'Passw0rd!1234',
            name: 'New User',
          }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(503);
      expect(res.body).toMatch(/registration.*paused/i);
      expect(cognito.send).not.toHaveBeenCalled();
    });

    it('returns 201 on successful Cognito SignUp', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { signup } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockResolvedValueOnce({} as never);

      const res = (await signup(
        buildEvent({
          body: JSON.stringify({
            email: 'new@example.com',
            password: 'Passw0rd!1234',
            name: 'New User',
          }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toMatchObject({
        message: expect.stringContaining('check your email'),
      });
    });

    it('translates UsernameExistsException to 400', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { signup } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('UsernameExistsException'));

      const res = (await signup(
        buildEvent({
          body: JSON.stringify({
            email: 'taken@example.com',
            password: 'Passw0rd!1234',
            name: 'Taken',
          }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/already exists/i);
    });

    it('translates InvalidPasswordException to 400', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { signup } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('InvalidPasswordException'));

      const res = (await signup(
        buildEvent({
          body: JSON.stringify({
            email: 'a@b.com',
            password: 'Passw0rd!1234',
            name: 'Ann',
          }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/password/i);
    });
  });

  describe('email confirmation', () => {
    it('records the trusted signup conversion without email or code', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { logger } = await import('../../../src/utils/logger.js');
      const requestInfo = vi.fn();
      const childSpy = vi.spyOn(logger, 'child').mockReturnValue({
        info: requestInfo,
        error: vi.fn(),
      } as never);
      vi.mocked(cognito.send).mockResolvedValueOnce({} as never);

      try {
        const { confirmEmail } = await import('../../../src/handlers/auth/handler.js');
        const res = (await confirmEmail(
          buildEvent({
            path: '/auth/confirm',
            body: JSON.stringify({ email: 'new@example.com', code: '123456' }),
          }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;

        expect(res.statusCode).toBe(200);
        expect(requestInfo).toHaveBeenCalledWith(
          {
            msg: 'product_event',
            productEvent: 'signup_completed',
            source: 'auth_confirmation',
          },
          'product_event'
        );
        expect(JSON.stringify(requestInfo.mock.calls)).not.toContain('new@example.com');
        expect(JSON.stringify(requestInfo.mock.calls)).not.toContain('123456');
      } finally {
        childSpy.mockRestore();
      }
    });
  });

  describe('login', () => {
    it('returns user + tokens on success', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { login } = await import('../../../src/handlers/auth/handler.js');
      // First call = InitiateAuth, second call = GetUser. The handler
      // dispatches both off the same `cognito.send`, so mock by sequence.
      vi.mocked(cognito.send)
        .mockResolvedValueOnce({
          AuthenticationResult: {
            IdToken: 'id-token',
            AccessToken: 'access-token',
            RefreshToken: 'refresh-token',
            ExpiresIn: 3600,
          },
        } as never)
        .mockResolvedValueOnce({
          UserAttributes: [
            { Name: 'sub', Value: 'user-1' },
            { Name: 'email', Value: 'test@example.com' },
            { Name: 'name', Value: 'Test User' },
            { Name: 'custom:household_id', Value: 'hh-1' },
            { Name: 'custom:household_role', Value: 'admin' },
          ],
        } as never);

      const res = (await login(
        buildEvent({
          body: JSON.stringify({ email: 'test@example.com', password: 'Passw0rd!' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        idToken: 'id-token',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      });
    });

    it('returns 401 on NotAuthorizedException', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { login } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('NotAuthorizedException'));

      const res = (await login(
        buildEvent({
          body: JSON.stringify({ email: 'a@b.com', password: 'wrong' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatch(/invalid email or password/i);
    });

    it('returns 401 on UserNotConfirmedException', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { login } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('UserNotConfirmedException'));

      const res = (await login(
        buildEvent({
          body: JSON.stringify({ email: 'a@b.com', password: 'Passw0rd!' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatch(/confirm your email/i);
    });
  });

  describe('forgotPassword', () => {
    it('returns 200 with neutral message even when user does not exist', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { forgotPassword } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('UserNotFoundException'));

      const res = (await forgotPassword(
        buildEvent({ body: JSON.stringify({ email: 'ghost@example.com' }) }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).message).toMatch(/if an account exists/i);
    });
  });

  describe('resetPassword', () => {
    it('translates CodeMismatchException to 400', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { resetPassword } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('CodeMismatchException'));

      const res = (await resetPassword(
        buildEvent({
          body: JSON.stringify({ email: 'a@b.com', code: '123456', newPassword: 'Password1234' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/invalid reset code/i);
    });

    it('translates ExpiredCodeException to 400', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { resetPassword } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('ExpiredCodeException'));

      const res = (await resetPassword(
        buildEvent({
          body: JSON.stringify({ email: 'a@b.com', code: '123456', newPassword: 'Password1234' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/expired/i);
    });
  });

  describe('changePassword', () => {
    it('rejects when x-cognito-access-token header is missing', async () => {
      const { changePassword } = await import('../../../src/handlers/auth/handler.js');
      const res = (await changePassword(
        buildEvent({
          headers: { Authorization: 'Bearer id-token' },
          body: JSON.stringify({ oldPassword: 'old', newPassword: 'Password1234' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatch(/access token/i);
    });

    it('translates NotAuthorizedException to 401', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { changePassword } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('NotAuthorizedException'));

      const res = (await changePassword(
        buildEvent({
          headers: { Authorization: 'Bearer id-token', 'x-cognito-access-token': 'access-token' },
          body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'Password1234' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatch(/current password/i);
    });
  });

  describe('getMe', () => {
    it('returns claim-derived identity merged with the Cognito display name', async () => {
      const { getUserName } = await import('../../../src/services/cognitoUsers.js');
      const { getMe } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(getUserName).mockResolvedValueOnce('Display Name');

      const res = (await getMe(
        buildEvent({
          httpMethod: 'GET',
          headers: { Authorization: 'Bearer id-token' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Display Name',
        householdId: 'hh-1',
        householdRole: 'admin',
      });
    });
  });

  describe('updateProfile', () => {
    it('fans the new name out to Cognito + DDB members table', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { updateMemberNameAcrossHouseholds } =
        await import('../../../src/services/householdService.js');
      const { updateProfile } = await import('../../../src/handlers/auth/handler.js');
      // 1st send = GetUser (access-token subject verification),
      // 2nd send = UpdateUserAttributes.
      vi.mocked(cognito.send)
        .mockResolvedValueOnce({
          Username: 'user-1',
          UserAttributes: [{ Name: 'sub', Value: 'user-1' }],
        } as never)
        .mockResolvedValueOnce({} as never);

      const res = (await updateProfile(
        buildEvent({
          httpMethod: 'PATCH',
          headers: { Authorization: 'Bearer id-token', 'x-cognito-access-token': 'access-token' },
          body: JSON.stringify({ name: 'Renamed' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe('Renamed');
      expect(updateMemberNameAcrossHouseholds).toHaveBeenCalledWith('user-1', 'Renamed');
    });

    it('403s when the access token belongs to a different user than the ID token', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { updateMemberNameAcrossHouseholds } =
        await import('../../../src/services/householdService.js');
      const { updateProfile } = await import('../../../src/handlers/auth/handler.js');
      // GetUser resolves to a DIFFERENT subject than the authenticated caller:
      // confused-deputy attempt (their ID token + someone else's access token).
      vi.mocked(cognito.send).mockResolvedValueOnce({
        Username: 'user-9',
        UserAttributes: [{ Name: 'sub', Value: 'user-9' }],
      } as never);

      const res = (await updateProfile(
        buildEvent({
          httpMethod: 'PATCH',
          headers: { Authorization: 'Bearer id-token', 'x-cognito-access-token': 'stolen-token' },
          body: JSON.stringify({ name: 'Hijack' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/does not match/i);
      // No attribute write, no DDB fan-out under the wrong identity.
      expect(vi.mocked(cognito.send)).toHaveBeenCalledTimes(1);
      expect(updateMemberNameAcrossHouseholds).not.toHaveBeenCalled();
    });

    it('401s when the access token is invalid (GetUser rejects)', async () => {
      const { cognito } = await import('../../../src/utils/cognito.js');
      const { updateProfile } = await import('../../../src/handlers/auth/handler.js');
      vi.mocked(cognito.send).mockRejectedValueOnce(new CognitoError('NotAuthorizedException'));

      const res = (await updateProfile(
        buildEvent({
          httpMethod: 'PATCH',
          headers: { Authorization: 'Bearer id-token', 'x-cognito-access-token': 'expired' },
          body: JSON.stringify({ name: 'Renamed' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatch(/invalid cognito access token/i);
    });

    it('400s on empty name (Zod rejects min(1) trimmed)', async () => {
      const { updateProfile } = await import('../../../src/handlers/auth/handler.js');
      const res = (await updateProfile(
        buildEvent({
          httpMethod: 'PATCH',
          headers: { Authorization: 'Bearer id-token', 'x-cognito-access-token': 'access-token' },
          body: JSON.stringify({ name: '   ' }),
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
    });
  });
});
