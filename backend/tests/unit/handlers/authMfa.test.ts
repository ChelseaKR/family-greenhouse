/**
 * Two-step verification handlers (#671): handlers/auth/mfa.ts plus the
 * challenge branch of POST /auth/login.
 *
 * Cognito is mocked by COMMAND NAME rather than by call order, so each test
 * states which Cognito calls it expects and a handler that makes an extra one
 * (an AssociateSoftwareToken after a failed re-authentication, say) fails
 * loudly on the missing responder instead of consuming another test's value.
 *
 * The log-capture tests swap the silent test logger for a real pino logger
 * writing into an array. Each one first asserts the capture saw the handler's
 * own audit line — so "the secret is not in the logs" can never pass because
 * nothing was being captured at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'trace';
  const logger = actual.createLogger({ write: (line: string) => captured.lines.push(line) });
  process.env.LOG_LEVEL = previous;
  return {
    ...actual,
    logger,
    withRequest: (ctx: Parameters<typeof actual.withRequest>[0], base = logger) =>
      actual.withRequest(ctx, base),
  };
});
vi.mock('../../../src/utils/cognito.js', () => ({
  cognito: { send: vi.fn() },
  CLIENT_ID: 'test-client-id',
  USER_POOL_ID: 'test-pool',
}));
vi.mock('../../../src/services/cognitoUsers.js', () => ({
  getUserName: vi.fn(),
  getMfaState: vi.fn(),
}));
vi.mock('../../../src/services/householdService.js', () => ({
  updateMemberNameAcrossHouseholds: vi.fn(),
}));
vi.mock('../../../src/services/signupConfirmRecord.js', () => ({
  recordSignup: vi.fn(),
}));
vi.mock('../../../src/config/commercialStatus.js', () => ({
  publicRegistrationIsAvailable: () => true,
}));

const ctx = {} as Context;
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

class CognitoError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

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

const AUTHED = { Authorization: 'Bearer id-token', 'x-cognito-access-token': 'access-token' };

type Responder = (input: Record<string, unknown>) => unknown;

/** Route `cognito.send` by command class name; an unlisted command throws. */
async function respond(responders: Record<string, Responder>) {
  const { cognito } = await import('../../../src/utils/cognito.js');
  vi.mocked(cognito.send).mockImplementation((async (command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) => {
    const responder = responders[command.constructor.name];
    if (!responder) throw new Error(`unexpected Cognito call: ${command.constructor.name}`);
    return responder(command.input);
  }) as never);
  return vi.mocked(cognito.send);
}

function commandsSent(send: { mock: { calls: unknown[][] } }): string[] {
  return send.mock.calls.map(
    (call) => (call[0] as { constructor: { name: string } }).constructor.name
  );
}

function inputOf(send: { mock: { calls: unknown[][] } }, name: string): Record<string, unknown> {
  const call = send.mock.calls.find(
    (c) => (c[0] as { constructor: { name: string } }).constructor.name === name
  );
  if (!call) throw new Error(`${name} was not sent`);
  return (call[0] as { input: Record<string, unknown> }).input;
}

const callerIdentity = () => ({
  Username: 'user-1',
  UserAttributes: [
    { Name: 'sub', Value: 'user-1' },
    { Name: 'email', Value: 'test@example.com' },
    { Name: 'name', Value: 'Test User' },
  ],
});

const tokens = {
  AuthenticationResult: {
    IdToken: 'fresh-id',
    AccessToken: 'fresh-access',
    RefreshToken: 'fresh-refresh',
    ExpiresIn: 3600,
  },
};

function bodyOf(res: APIGatewayProxyResult) {
  return JSON.parse(res.body) as {
    message?: string;
    details?: { code?: string };
    [key: string]: unknown;
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  captured.lines.length = 0;
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  // authMiddleware validates the claim household against the membership
  // table; pre-warm its cache so the partial householdService mock is never
  // consulted (the same arrangement as auth.test.ts).
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('user-1', 'hh-1', 'admin');
});

describe('POST /auth/login with an authenticator on', () => {
  it('returns the challenge, with Cognito’s username, and mints no tokens', async () => {
    const send = await respond({
      InitiateAuthCommand: () => ({
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: 'cognito-session',
        ChallengeParameters: { USER_ID_FOR_SRP: 'user-1' },
      }),
    });
    const { login } = await import('../../../src/handlers/auth/handler.js');
    const res = (await login(
      buildEvent({ body: JSON.stringify({ email: 'test@example.com', password: 'pw' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      challenge: 'SOFTWARE_TOKEN_MFA',
      session: 'cognito-session',
      username: 'user-1',
    });
    expect(commandsSent(send)).toEqual(['InitiateAuthCommand']);
  });

  it('names a challenge it cannot answer instead of a bare 500', async () => {
    await respond({
      InitiateAuthCommand: () => ({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }),
    });
    const { login } = await import('../../../src/handlers/auth/handler.js');
    const res = (await login(
      buildEvent({ body: JSON.stringify({ email: 'test@example.com', password: 'pw' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).details?.code).toBe('UNSUPPORTED_CHALLENGE');
  });
});

describe('POST /auth/login/mfa', () => {
  const answer = (code = '123456') =>
    buildEvent({
      body: JSON.stringify({ username: 'user-1', session: 'cognito-session', code }),
    });

  it('answers the challenge and returns the normal sign-in body', async () => {
    const send = await respond({
      RespondToAuthChallengeCommand: () => tokens,
      GetUserCommand: () => ({
        UserAttributes: [
          ...callerIdentity().UserAttributes,
          { Name: 'custom:household_id', Value: 'hh-1' },
          { Name: 'custom:household_role', Value: 'admin' },
        ],
      }),
    });
    const { loginMfa } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await loginMfa(answer(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      idToken: 'fresh-id',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      user: { id: 'user-1', householdId: 'hh-1' },
    });
    expect(inputOf(send, 'RespondToAuthChallengeCommand')).toEqual({
      ClientId: 'test-client-id',
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: 'cognito-session',
      ChallengeResponses: { USERNAME: 'user-1', SOFTWARE_TOKEN_MFA_CODE: '123456' },
    });
  });

  it('a wrong code is a coded 400, not a 401 the client would treat as a lost session', async () => {
    await respond({
      RespondToAuthChallengeCommand: () => {
        throw new CognitoError('CodeMismatchException');
      },
    });
    const { loginMfa } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await loginMfa(answer('000000'), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).details?.code).toBe('INVALID_CODE');
  });

  it.each(['NotAuthorizedException', 'ExpiredCodeException'])(
    '%s means the challenge is spent: 401 MFA_SESSION_EXPIRED',
    async (name) => {
      await respond({
        RespondToAuthChallengeCommand: () => {
          throw new CognitoError(name);
        },
      });
      const { loginMfa } = await import('../../../src/handlers/auth/mfa.js');
      const res = (await loginMfa(answer(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(401);
      expect(bodyOf(res).details?.code).toBe('MFA_SESSION_EXPIRED');
    }
  );

  it('rejects a malformed code before calling Cognito', async () => {
    const send = await respond({});
    const { loginMfa } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await loginMfa(answer('12345'), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('GET /auth/mfa', () => {
  it('reports the factor Cognito has on', async () => {
    const { getMfaState } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(getMfaState).mockResolvedValueOnce({ totpEnabled: true });
    const { getMfaStatus } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await getMfaStatus(
      buildEvent({ httpMethod: 'GET', headers: { Authorization: 'Bearer id-token' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ totp: { enabled: true } });
    expect(getMfaState).toHaveBeenCalledWith('user-1');
  });

  it('a failed Cognito read is a failure, never "off"', async () => {
    const { getMfaState } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(getMfaState).mockRejectedValueOnce(new CognitoError('InternalErrorException'));
    const { getMfaStatus } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await getMfaStatus(
      buildEvent({ httpMethod: 'GET', headers: { Authorization: 'Bearer id-token' } }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/enabled/);
  });
});

describe('POST /auth/mfa/totp/setup', () => {
  const setup = (headers: Record<string, string> = AUTHED, password = 'Password1234') =>
    buildEvent({ headers, body: JSON.stringify({ password }) });

  it('re-authenticates, associates with the caller’s token, and returns the secret uncached', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => tokens,
      RevokeTokenCommand: () => ({}),
      AssociateSoftwareTokenCommand: () => ({ SecretCode: SECRET }),
    });
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(setup(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ secretCode: SECRET });
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    expect(inputOf(send, 'InitiateAuthCommand')).toMatchObject({
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'test@example.com', PASSWORD: 'Password1234' },
    });
    expect(inputOf(send, 'AssociateSoftwareTokenCommand')).toEqual({ AccessToken: 'access-token' });
    // The refresh token the re-authentication minted never outlives it.
    expect(inputOf(send, 'RevokeTokenCommand')).toEqual({
      ClientId: 'test-client-id',
      Token: 'fresh-refresh',
    });
  });

  it('never writes the secret to a log line (and the capture is live)', async () => {
    await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => tokens,
      RevokeTokenCommand: () => ({}),
      AssociateSoftwareTokenCommand: () => ({ SecretCode: SECRET }),
    });
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(setup(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);

    const logs = captured.lines.join('\n');
    // The control: this capture really receives the handler's lines.
    expect(logs).toContain('auth.mfa.totp_setup_started');
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain('Password1234');
  });

  it('401s without the access-token header, before any Cognito call', async () => {
    const send = await respond({});
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(
      setup({ Authorization: 'Bearer id-token' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('403s when the access token is someone else’s', async () => {
    const send = await respond({
      GetUserCommand: () => ({
        Username: 'user-9',
        UserAttributes: [{ Name: 'sub', Value: 'user-9' }],
      }),
    });
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(setup(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(403);
    expect(commandsSent(send)).toEqual(['GetUserCommand']);
  });

  it('a wrong password is a coded 400 and no secret is issued', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => {
        throw new CognitoError('NotAuthorizedException');
      },
    });
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(
      setup(AUTHED, 'wrong'),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).details?.code).toBe('REAUTH_FAILED');
    expect(commandsSent(send)).not.toContain('AssociateSoftwareTokenCommand');
  });

  it('an account that already has an authenticator is refused, not re-keyed', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => ({
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: 's',
        ChallengeParameters: { USER_ID_FOR_SRP: 'user-1' },
      }),
    });
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(setup(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).details?.code).toBe('TOTP_ALREADY_ENABLED');
    expect(commandsSent(send)).not.toContain('AssociateSoftwareTokenCommand');
  });

  it('refuses when the re-authenticated account is not the caller', async () => {
    let getUserCalls = 0;
    const send = await respond({
      // First GetUser: the header token is the caller's. Second: the fresh
      // token from re-authentication belongs to someone else.
      GetUserCommand: () =>
        ++getUserCalls === 1
          ? callerIdentity()
          : { Username: 'user-9', UserAttributes: [{ Name: 'sub', Value: 'user-9' }] },
      InitiateAuthCommand: () => tokens,
      RevokeTokenCommand: () => ({}),
    });
    const { startTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await startTotpSetup(setup(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(403);
    expect(commandsSent(send)).not.toContain('AssociateSoftwareTokenCommand');
    // Still revoked: the stray refresh token is cleaned up on the refusal too.
    expect(commandsSent(send)).toContain('RevokeTokenCommand');
  });
});

describe('POST /auth/mfa/totp/verify', () => {
  const verify = (code = '123456') =>
    buildEvent({ headers: AUTHED, body: JSON.stringify({ code }) });

  it('verifies the first code, then turns the factor on and makes it preferred', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      VerifySoftwareTokenCommand: () => ({ Status: 'SUCCESS' }),
      SetUserMFAPreferenceCommand: () => ({}),
    });
    const { verifyTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await verifyTotpSetup(verify(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ totp: { enabled: true } });
    expect(inputOf(send, 'VerifySoftwareTokenCommand')).toMatchObject({
      AccessToken: 'access-token',
      UserCode: '123456',
    });
    expect(inputOf(send, 'SetUserMFAPreferenceCommand')).toEqual({
      AccessToken: 'access-token',
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });
  });

  it.each(['CodeMismatchException', 'EnableSoftwareTokenMFAException'])(
    '%s leaves the factor off: coded 400, no preference change',
    async (name) => {
      const send = await respond({
        GetUserCommand: callerIdentity,
        VerifySoftwareTokenCommand: () => {
          throw new CognitoError(name);
        },
      });
      const { verifyTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
      const res = (await verifyTotpSetup(verify('000000'), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).details?.code).toBe('INVALID_CODE');
      expect(commandsSent(send)).not.toContain('SetUserMFAPreferenceCommand');
    }
  );

  it('a non-SUCCESS status is treated as a wrong code, not as success', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      VerifySoftwareTokenCommand: () => ({ Status: 'ERROR' }),
    });
    const { verifyTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await verifyTotpSetup(verify(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(commandsSent(send)).not.toContain('SetUserMFAPreferenceCommand');
  });

  it('verify with no setup in progress asks to start again', async () => {
    await respond({
      GetUserCommand: callerIdentity,
      VerifySoftwareTokenCommand: () => {
        throw new CognitoError('InvalidParameterException');
      },
    });
    const { verifyTotpSetup } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await verifyTotpSetup(verify(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).details?.code).toBe('TOTP_SETUP_NOT_STARTED');
  });
});

describe('POST /auth/mfa/totp/disable', () => {
  const disable = (password = 'Password1234', code = '123456') =>
    buildEvent({
      headers: { Authorization: 'Bearer id-token' },
      body: JSON.stringify({ password, code }),
    });

  const challenged = () => ({
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    Session: 'reauth-session',
    ChallengeParameters: { USER_ID_FOR_SRP: 'user-1' },
  });

  it('re-authenticates with BOTH factors, then turns TOTP off with the fresh token', async () => {
    const send = await respond({
      InitiateAuthCommand: challenged,
      RespondToAuthChallengeCommand: () => tokens,
      GetUserCommand: callerIdentity,
      RevokeTokenCommand: () => ({}),
      SetUserMFAPreferenceCommand: () => ({}),
    });
    const { disableTotp } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await disableTotp(disable(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ totp: { enabled: false } });
    expect(inputOf(send, 'RespondToAuthChallengeCommand')).toMatchObject({
      Session: 'reauth-session',
      ChallengeResponses: { USERNAME: 'user-1', SOFTWARE_TOKEN_MFA_CODE: '123456' },
    });
    expect(inputOf(send, 'SetUserMFAPreferenceCommand')).toEqual({
      AccessToken: 'fresh-access',
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    });
    const order = commandsSent(send);
    expect(order.indexOf('RespondToAuthChallengeCommand')).toBeLessThan(
      order.indexOf('SetUserMFAPreferenceCommand')
    );
  });

  it('a wrong code keeps the factor on', async () => {
    const send = await respond({
      InitiateAuthCommand: challenged,
      RespondToAuthChallengeCommand: () => {
        throw new CognitoError('CodeMismatchException');
      },
    });
    const { disableTotp } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await disableTotp(disable(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).details?.code).toBe('INVALID_CODE');
    expect(commandsSent(send)).not.toContain('SetUserMFAPreferenceCommand');
  });

  it('a wrong password keeps the factor on', async () => {
    const send = await respond({
      InitiateAuthCommand: () => {
        throw new CognitoError('NotAuthorizedException');
      },
    });
    const { disableTotp } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await disableTotp(disable('wrong'), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).details?.code).toBe('REAUTH_FAILED');
    expect(commandsSent(send)).toEqual(['InitiateAuthCommand']);
  });

  it('never logs the password or the code (and the capture is live)', async () => {
    await respond({
      InitiateAuthCommand: challenged,
      RespondToAuthChallengeCommand: () => tokens,
      GetUserCommand: callerIdentity,
      RevokeTokenCommand: () => ({}),
      SetUserMFAPreferenceCommand: () => ({}),
    });
    const { disableTotp } = await import('../../../src/handlers/auth/mfa.js');
    const res = (await disableTotp(
      disable('Password1234', '975310'),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);

    const logs = captured.lines.join('\n');
    expect(logs).toContain('auth.mfa.totp_disabled');
    expect(logs).not.toContain('Password1234');
    expect(logs).not.toContain('975310');
  });
});
