/**
 * Passkeys (#671) against the local mock server (src/local-server-passkeys.ts).
 *
 * The mock is the backend the Playwright e2e drives with a real browser
 * WebAuthn stack; this file pins its contract directly: off by default exactly
 * as production ships, the ceremony binding it does check (type, challenge,
 * credential id, owner), and the re-authentication in front of adding one.
 * Signatures are Cognito's to verify in production and are not checked here —
 * the module header says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, resetDb } from '../../src/local-server';
import { totpCode } from '../../src/local-server-mfa';

const EMAIL = 'test@example.com';
const PASSWORD = 'password123';

interface Session {
  idToken: string;
  accessToken: string;
}

async function signIn(): Promise<Session> {
  const res = await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body as Session;
}

function authed(req: request.Test, session: Session): request.Test {
  return req
    .set('Authorization', `Bearer ${session.idToken}`)
    .set('X-Cognito-Access-Token', session.accessToken);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function attestation(id: string, challenge: string, type = 'webauthn.create') {
  return {
    id,
    rawId: id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64({ type, challenge, origin: 'http://localhost:3000' }),
      attestationObject: 'o2NmbXRkbm9uZQ',
    },
  };
}

function assertion(id: string, challenge: string, type = 'webauthn.get') {
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64({ type, challenge, origin: 'http://localhost:3000' }),
      authenticatorData: 'AA',
      signature: 'AA',
    },
  };
}

async function register(session: Session, id = 'cred-1'): Promise<void> {
  const start = await authed(request(app).post('/auth/passkeys/register/start'), session).send({
    password: PASSWORD,
  });
  expect(start.status).toBe(200);
  const finish = await authed(request(app).post('/auth/passkeys/register/finish'), session).send({
    credential: attestation(id, start.body.options.challenge),
  });
  expect(finish.status).toBe(201);
}

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  delete process.env.PASSKEYS_ENABLED;
  delete process.env.ALLOW_TEST_ACCOUNT_PROVISIONING;
});

describe('off by default, as production ships', () => {
  it('the probe says unavailable and every route is 404 PASSKEYS_DISABLED', async () => {
    const probe = await request(app).get('/auth/passkeys/available');
    expect(probe.body).toEqual({ available: false });

    const session = await signIn();
    const responses = [
      await request(app).post('/auth/login/passkey/start').send({ email: EMAIL }),
      await authed(request(app).get('/auth/passkeys'), session),
      await authed(request(app).post('/auth/passkeys/register/start'), session).send({
        password: PASSWORD,
      }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.details.code).toBe('PASSKEYS_DISABLED');
    }
  });

  it('the e2e fixture opt-in serves the routes but never changes the probe', async () => {
    process.env.ALLOW_TEST_ACCOUNT_PROVISIONING = '1';
    const probe = await request(app).get('/auth/passkeys/available');
    expect(probe.body).toEqual({ available: false });
    const session = await signIn();
    const list = await authed(request(app).get('/auth/passkeys'), session);
    expect(list.status).toBe(200);
  });
});

describe('with passkeys on', () => {
  beforeEach(() => {
    process.env.PASSKEYS_ENABLED = '1';
  });

  it('register → list → sign in with it → remove', async () => {
    expect((await request(app).get('/auth/passkeys/available')).body).toEqual({ available: true });
    const session = await signIn();
    await register(session);

    const list = await authed(request(app).get('/auth/passkeys'), session);
    expect(list.body.passkeys).toHaveLength(1);
    expect(list.body.passkeys[0]).toMatchObject({ id: 'cred-1', attachment: 'platform' });

    const start = await request(app).post('/auth/login/passkey/start').send({ email: EMAIL });
    expect(start.status).toBe(200);
    expect(start.body.options.allowCredentials).toEqual([{ type: 'public-key', id: 'cred-1' }]);
    const finish = await request(app)
      .post('/auth/login/passkey/finish')
      .send({
        username: start.body.username,
        session: start.body.session,
        credential: assertion('cred-1', start.body.options.challenge),
      });
    expect(finish.status).toBe(200);
    expect(finish.body.idToken).toBeTruthy();

    const removed = await authed(request(app).delete('/auth/passkeys/cred-1'), session);
    expect(removed.status).toBe(204);
    const after = await authed(request(app).get('/auth/passkeys'), session);
    expect(after.body.passkeys).toEqual([]);
  });

  it('refuses an assertion for a different challenge, ceremony or credential', async () => {
    const session = await signIn();
    await register(session);

    const cases = [
      (challenge: string) => assertion('cred-1', `${challenge}x`),
      (challenge: string) => assertion('cred-1', challenge, 'webauthn.create'),
      (challenge: string) => assertion('cred-unknown', challenge),
    ];
    for (const make of cases) {
      const start = await request(app).post('/auth/login/passkey/start').send({ email: EMAIL });
      const res = await request(app)
        .post('/auth/login/passkey/finish')
        .send({
          username: start.body.username,
          session: start.body.session,
          credential: make(start.body.options.challenge),
        });
      expect(res.status).toBe(401);
      expect(res.body.details.code).toBe('PASSKEY_REJECTED');
      expect(res.body.idToken).toBeUndefined();
    }
  });

  it('an account with no passkey gets NO_PASSKEY, as does an unknown email', async () => {
    for (const email of [EMAIL, 'nobody@example.com']) {
      const res = await request(app).post('/auth/login/passkey/start').send({ email });
      expect(res.status).toBe(409);
      expect(res.body.details.code).toBe('NO_PASSKEY');
    }
  });

  it('adding re-authenticates: a wrong password is refused', async () => {
    const session = await signIn();
    const res = await authed(request(app).post('/auth/passkeys/register/start'), session).send({
      password: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.code).toBe('REAUTH_FAILED');
  });

  it('with an authenticator app on, adding needs the current code too', async () => {
    const session = await signIn();
    const setup = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
      password: PASSWORD,
    });
    const secret = setup.body.secretCode as string;
    await authed(request(app).post('/auth/mfa/totp/verify'), session).send({
      code: totpCode(secret, Date.now()),
    });

    const noCode = await authed(request(app).post('/auth/passkeys/register/start'), session).send({
      password: PASSWORD,
    });
    expect(noCode.status).toBe(400);
    expect(noCode.body.details.code).toBe('CODE_REQUIRED');

    const withCode = await authed(request(app).post('/auth/passkeys/register/start'), session).send(
      { password: PASSWORD, code: totpCode(secret, Date.now()) }
    );
    expect(withCode.status).toBe(200);
    expect(withCode.body.options.challenge).toBeTruthy();
  });

  it('an attestation for a stale challenge is refused and nothing is stored', async () => {
    const session = await signIn();
    const start = await authed(request(app).post('/auth/passkeys/register/start'), session).send({
      password: PASSWORD,
    });
    const res = await authed(request(app).post('/auth/passkeys/register/finish'), session).send({
      credential: attestation('cred-1', `${start.body.options.challenge}x`),
    });
    expect(res.status).toBe(400);
    expect(res.body.details.code).toBe('PASSKEY_REJECTED');
    expect((await authed(request(app).get('/auth/passkeys'), session)).body.passkeys).toEqual([]);
  });
});
