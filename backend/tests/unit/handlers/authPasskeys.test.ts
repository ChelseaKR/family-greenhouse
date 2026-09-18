/**
 * Passkey handlers (#671, second half): handlers/auth/passkeys.ts.
 *
 * Same arrangement as authMfa.test.ts: Cognito mocked by COMMAND NAME, so an
 * unexpected call fails loudly, and a live log capture for the "nothing
 * sensitive is logged" assertions. The first block runs with the deployment
 * switch OFF — the state production ships in — and proves every route is
 * inert without touching Cognito.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
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

afterEach(() => {
  delete process.env.PASSKEYS_ENABLED;
});

const CREDENTIAL = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  authenticatorAttachment: 'platform',
  clientExtensionResults: {},
  response: { clientDataJSON: 'eyJ9', authenticatorData: 'AA', signature: 'AA' },
};

const REQUEST_OPTIONS = {
  challenge: 'Y2hhbGxlbmdl',
  rpId: 'familygreenhouse.net',
  allowCredentials: [],
};

async function handlers() {
  return import('../../../src/handlers/auth/passkeys.js');
}

describe('with passkeys OFF (the shipped default)', () => {
  it('the availability probe says so, cacheably', async () => {
    const send = await respond({});
    const { passkeysAvailable } = await handlers();
    const res = (await passkeysAvailable(
      buildEvent({ httpMethod: 'GET' }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ available: false });
    expect(res.headers?.['Cache-Control']).toBe('public, max-age=300');
    expect(send).not.toHaveBeenCalled();
  });

  it('every other route is 404 PASSKEYS_DISABLED and never reaches Cognito', async () => {
    const send = await respond({});
    const h = await handlers();
    const calls: Array<[string, APIGatewayProxyResult]> = [
      [
        'start',
        (await h.passkeySignInStart(
          buildEvent({ body: JSON.stringify({ email: 'test@example.com' }) }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult,
      ],
      [
        'finish',
        (await h.passkeySignInFinish(
          buildEvent({
            body: JSON.stringify({ username: 'u', session: 's', credential: CREDENTIAL }),
          }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult,
      ],
      [
        'list',
        (await h.listPasskeys(
          buildEvent({ httpMethod: 'GET', headers: AUTHED }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult,
      ],
      [
        'register/start',
        (await h.passkeyRegisterStart(
          buildEvent({ headers: AUTHED, body: JSON.stringify({ password: 'Password1234' }) }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult,
      ],
      [
        'register/finish',
        (await h.passkeyRegisterFinish(
          buildEvent({ headers: AUTHED, body: JSON.stringify({ credential: CREDENTIAL }) }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult,
      ],
      [
        'delete',
        (await h.deletePasskey(
          buildEvent({
            httpMethod: 'DELETE',
            headers: AUTHED,
            pathParameters: { credentialId: 'cred-1' },
          }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult,
      ],
    ];
    for (const [name, res] of calls) {
      expect(res.statusCode, name).toBe(404);
      expect(bodyOf(res).details?.code, name).toBe('PASSKEYS_DISABLED');
    }
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sign-in with a passkey', () => {
  beforeEach(() => {
    process.env.PASSKEYS_ENABLED = '1';
  });

  it('starts Cognito choice-based auth preferring WEB_AUTHN and returns the parsed options', async () => {
    const send = await respond({
      InitiateAuthCommand: () => ({
        ChallengeName: 'WEB_AUTHN',
        Session: 'webauthn-session',
        ChallengeParameters: {
          USERNAME: 'user-1',
          CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(REQUEST_OPTIONS),
        },
      }),
    });
    const { passkeySignInStart } = await handlers();
    const res = (await passkeySignInStart(
      buildEvent({ body: JSON.stringify({ email: 'test@example.com' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      session: 'webauthn-session',
      username: 'user-1',
      options: REQUEST_OPTIONS,
    });
    expect(inputOf(send, 'InitiateAuthCommand')).toEqual({
      ClientId: 'test-client-id',
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: 'test@example.com', PREFERRED_CHALLENGE: 'WEB_AUTHN' },
    });
  });

  it.each([
    [
      'another challenge (no passkey registered)',
      () => ({ ChallengeName: 'SELECT_CHALLENGE', Session: 's' }),
    ],
    [
      'NotAuthorizedException (no such account)',
      () => {
        throw new CognitoError('NotAuthorizedException');
      },
    ],
  ])('%s: the same 409 NO_PASSKEY, so emails are not enumerable', async (_label, answer) => {
    await respond({ InitiateAuthCommand: answer });
    const { passkeySignInStart } = await handlers();
    const res = (await passkeySignInStart(
      buildEvent({ body: JSON.stringify({ email: 'someone@example.com' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).details?.code).toBe('NO_PASSKEY');
  });

  it('finishes with the assertion as Cognito’s CREDENTIAL and signs in', async () => {
    const send = await respond({
      RespondToAuthChallengeCommand: () => tokens,
      GetUserCommand: callerIdentity,
    });
    const { passkeySignInFinish } = await handlers();
    const res = (await passkeySignInFinish(
      buildEvent({
        body: JSON.stringify({
          username: 'user-1',
          session: 'webauthn-session',
          credential: CREDENTIAL,
        }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ idToken: 'fresh-id', user: { id: 'user-1' } });
    const input = inputOf(send, 'RespondToAuthChallengeCommand') as {
      ChallengeName: string;
      Session: string;
      ChallengeResponses: { USERNAME: string; CREDENTIAL: string };
    };
    expect(input.ChallengeName).toBe('WEB_AUTHN');
    expect(input.Session).toBe('webauthn-session');
    expect(input.ChallengeResponses.USERNAME).toBe('user-1');
    expect(JSON.parse(input.ChallengeResponses.CREDENTIAL)).toEqual(CREDENTIAL);
  });

  it.each([
    'NotAuthorizedException',
    'WebAuthnOriginNotAllowedException',
    'WebAuthnRelyingPartyMismatchException',
  ])('%s is a coded 401 PASSKEY_REJECTED, with no tokens', async (name) => {
    await respond({
      RespondToAuthChallengeCommand: () => {
        throw new CognitoError(name);
      },
    });
    const { passkeySignInFinish } = await handlers();
    const res = (await passkeySignInFinish(
      buildEvent({
        body: JSON.stringify({ username: 'user-1', session: 's', credential: CREDENTIAL }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res).details?.code).toBe('PASSKEY_REJECTED');
    expect(bodyOf(res).idToken).toBeUndefined();
  });

  it('refuses a malformed credential before Cognito sees it', async () => {
    const send = await respond({});
    const { passkeySignInFinish } = await handlers();
    const res = (await passkeySignInFinish(
      buildEvent({
        body: JSON.stringify({
          username: 'user-1',
          session: 's',
          credential: { ...CREDENTIAL, type: 'password' },
        }),
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('managing passkeys', () => {
  beforeEach(() => {
    process.env.PASSKEYS_ENABLED = '1';
  });

  it('lists the caller’s passkeys with the caller’s own access token', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      ListWebAuthnCredentialsCommand: () => ({
        Credentials: [
          {
            CredentialId: 'cred-1',
            FriendlyCredentialName: 'iCloud Keychain',
            RelyingPartyId: 'familygreenhouse.net',
            AuthenticatorAttachment: 'platform',
            AuthenticatorTransports: ['internal'],
            CreatedAt: new Date('2026-09-18T10:00:00Z'),
          },
        ],
      }),
    });
    const { listPasskeys } = await handlers();
    const res = (await listPasskeys(
      buildEvent({ httpMethod: 'GET', headers: AUTHED }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      passkeys: [
        {
          id: 'cred-1',
          name: 'iCloud Keychain',
          createdAt: '2026-09-18T10:00:00.000Z',
          attachment: 'platform',
        },
      ],
    });
    expect(inputOf(send, 'ListWebAuthnCredentialsCommand')).toMatchObject({
      AccessToken: 'access-token',
    });
  });

  it('adding re-authenticates first, then asks Cognito for creation options', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => tokens,
      RevokeTokenCommand: () => ({}),
      StartWebAuthnRegistrationCommand: () => ({
        CredentialCreationOptions: { challenge: 'abc', rp: { id: 'familygreenhouse.net' } },
      }),
    });
    const { passkeyRegisterStart } = await handlers();
    const res = (await passkeyRegisterStart(
      buildEvent({ headers: AUTHED, body: JSON.stringify({ password: 'Password1234' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      options: { challenge: 'abc', rp: { id: 'familygreenhouse.net' } },
    });
    const order = commandsSent(send);
    expect(order.indexOf('InitiateAuthCommand')).toBeLessThan(
      order.indexOf('StartWebAuthnRegistrationCommand')
    );
  });

  it('with an authenticator app on, adding needs the code too (CODE_REQUIRED, no options)', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => ({
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: 's',
        ChallengeParameters: { USER_ID_FOR_SRP: 'user-1' },
      }),
    });
    const { passkeyRegisterStart } = await handlers();
    const res = (await passkeyRegisterStart(
      buildEvent({ headers: AUTHED, body: JSON.stringify({ password: 'Password1234' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).details?.code).toBe('CODE_REQUIRED');
    expect(commandsSent(send)).not.toContain('StartWebAuthnRegistrationCommand');
  });

  it('a wrong password adds nothing', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      InitiateAuthCommand: () => {
        throw new CognitoError('NotAuthorizedException');
      },
    });
    const { passkeyRegisterStart } = await handlers();
    const res = (await passkeyRegisterStart(
      buildEvent({ headers: AUTHED, body: JSON.stringify({ password: 'nope' }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).details?.code).toBe('REAUTH_FAILED');
    expect(commandsSent(send)).not.toContain('StartWebAuthnRegistrationCommand');
  });

  it('finishing hands the attestation to Cognito, and the audit line carries no credential', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      CompleteWebAuthnRegistrationCommand: () => ({}),
    });
    const { passkeyRegisterFinish } = await handlers();
    const res = (await passkeyRegisterFinish(
      buildEvent({ headers: AUTHED, body: JSON.stringify({ credential: CREDENTIAL }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(201);
    expect(inputOf(send, 'CompleteWebAuthnRegistrationCommand')).toEqual({
      AccessToken: 'access-token',
      Credential: CREDENTIAL,
    });
    const logs = captured.lines.join('\n');
    expect(logs).toContain('auth.passkey.added');
    expect(logs).not.toContain('cred-1');
  });

  it('an expired registration asks to start again', async () => {
    await respond({
      GetUserCommand: callerIdentity,
      CompleteWebAuthnRegistrationCommand: () => {
        throw new CognitoError('WebAuthnChallengeNotFoundException');
      },
    });
    const { passkeyRegisterFinish } = await handlers();
    const res = (await passkeyRegisterFinish(
      buildEvent({ headers: AUTHED, body: JSON.stringify({ credential: CREDENTIAL }) }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).details?.code).toBe('PASSKEY_EXPIRED');
  });

  it('removes by id with the caller’s token; an unknown id is a 404', async () => {
    const send = await respond({
      GetUserCommand: callerIdentity,
      DeleteWebAuthnCredentialCommand: (input) => {
        if (input.CredentialId !== 'cred-1') throw new CognitoError('ResourceNotFoundException');
        return {};
      },
    });
    const { deletePasskey } = await handlers();
    const ok = (await deletePasskey(
      buildEvent({
        httpMethod: 'DELETE',
        headers: AUTHED,
        pathParameters: { credentialId: 'cred-1' },
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(ok.statusCode).toBe(204);
    expect(inputOf(send, 'DeleteWebAuthnCredentialCommand')).toEqual({
      AccessToken: 'access-token',
      CredentialId: 'cred-1',
    });

    const missing = (await deletePasskey(
      buildEvent({
        httpMethod: 'DELETE',
        headers: AUTHED,
        pathParameters: { credentialId: 'nope' },
      }),
      ctx,
      () => {}
    )) as APIGatewayProxyResult;
    expect(missing.statusCode).toBe(404);
  });
});
