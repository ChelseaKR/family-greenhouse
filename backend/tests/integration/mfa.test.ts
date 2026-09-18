/**
 * Two-step verification (#671) against the local mock server — the server the
 * Playwright e2e and the offline dev loop run on (src/local-server-mfa.ts).
 *
 * Two things are under test. First, the mock's TOTP arithmetic, against the
 * RFC 4226 / RFC 6238 published vectors: the mock has to CHECK codes the way
 * Cognito does, or a client that sends the wrong code would pass here and fail
 * in production. Second, the flows end to end over HTTP, with the same status
 * codes and `details.code` values the production handlers answer with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, resetDb } from '../../src/local-server';
import {
  base32Decode,
  base32Encode,
  hotp,
  totpCode,
  totpMatches,
} from '../../src/local-server-mfa';

// The RFC 6238 appendix B key, as ASCII. Its base32 form is derived with the
// encoder the RFC 4648 vectors below pin, not written out as a literal.
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = base32Encode(Buffer.from(RFC_SECRET_ASCII));

describe('mock TOTP arithmetic (RFC vectors)', () => {
  it.each([
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('base32 matches RFC 4648 section 10 (unpadded): %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('base32 round-trips the RFC 6238 key', () => {
    expect(RFC_SECRET_BASE32).toHaveLength(32);
    expect(base32Decode(RFC_SECRET_BASE32).toString()).toBe(RFC_SECRET_ASCII);
  });

  it('HOTP matches RFC 4226 appendix D', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => {
      expect(hotp(Buffer.from(RFC_SECRET_ASCII), counter)).toBe(code);
    });
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('TOTP at T=%i matches RFC 6238 appendix B (SHA-1)', (seconds, code) => {
    expect(totpCode(RFC_SECRET_BASE32, seconds * 1000, 8)).toBe(code);
  });

  it('accepts one step of clock skew either side, and no more', () => {
    const now = 1_234_567_890_000;
    const at = (offsetSteps: number) => totpCode(RFC_SECRET_BASE32, now + offsetSteps * 30_000);
    expect(totpMatches(RFC_SECRET_BASE32, at(0), now)).toBe(true);
    expect(totpMatches(RFC_SECRET_BASE32, at(-1), now)).toBe(true);
    expect(totpMatches(RFC_SECRET_BASE32, at(1), now)).toBe(true);
    expect(totpMatches(RFC_SECRET_BASE32, at(-2), now)).toBe(false);
    expect(totpMatches(RFC_SECRET_BASE32, at(2), now)).toBe(false);
  });
});

const EMAIL = 'test@example.com';
const PASSWORD = 'password123';

interface Session {
  idToken: string;
  accessToken: string;
}

async function signIn(): Promise<Session> {
  const res = await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body.idToken).toBeTruthy();
  return res.body as Session;
}

function authed(req: request.Test, session: Session, withAccessToken = true): request.Test {
  req.set('Authorization', `Bearer ${session.idToken}`);
  return withAccessToken ? req.set('X-Cognito-Access-Token', session.accessToken) : req;
}

/** A code that is NOT the current one (nor either neighbor). */
function wrongCode(secret: string): string {
  const now = Date.now();
  const valid = new Set([-1, 0, 1].map((d) => totpCode(secret, now + d * 30_000)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

async function enable(session: Session): Promise<string> {
  const setup = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
    password: PASSWORD,
  });
  expect(setup.status).toBe(200);
  const secret = setup.body.secretCode as string;
  const verify = await authed(request(app).post('/auth/mfa/totp/verify'), session).send({
    code: totpCode(secret, Date.now()),
  });
  expect(verify.status).toBe(200);
  return secret;
}

beforeEach(() => {
  resetDb();
  delete process.env.E2E_TOTP_SECRET_SEED;
});

afterEach(() => {
  delete process.env.E2E_TOTP_SECRET_SEED;
  delete process.env.ALLOW_TEST_ACCOUNT_PROVISIONING;
});

describe('enrollment', () => {
  it('starts off, and setup + first code turns it on', async () => {
    const session = await signIn();
    const before = await authed(request(app).get('/auth/mfa'), session, false);
    expect(before.body).toEqual({ totp: { enabled: false } });

    const setup = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
      password: PASSWORD,
    });
    expect(setup.status).toBe(200);
    expect(setup.headers['cache-control']).toBe('no-store');
    const secret = setup.body.secretCode as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    // A wrong first code leaves it off.
    const wrong = await authed(request(app).post('/auth/mfa/totp/verify'), session).send({
      code: wrongCode(secret),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.code).toBe('INVALID_CODE');
    const still = await authed(request(app).get('/auth/mfa'), session, false);
    expect(still.body.totp.enabled).toBe(false);

    const right = await authed(request(app).post('/auth/mfa/totp/verify'), session).send({
      code: totpCode(secret, Date.now()),
    });
    expect(right.status).toBe(200);
    const after = await authed(request(app).get('/auth/mfa'), session, false);
    expect(after.body).toEqual({ totp: { enabled: true } });
  });

  it('needs the access-token header, like production', async () => {
    const session = await signIn();
    const res = await authed(request(app).post('/auth/mfa/totp/setup'), session, false).send({
      password: PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it('refuses a wrong password with REAUTH_FAILED and issues no secret', async () => {
    const session = await signIn();
    const res = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
      password: 'not-the-password',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.code).toBe('REAUTH_FAILED');
    expect(res.body.secretCode).toBeUndefined();
  });

  it('refuses to re-key an account that already has an authenticator', async () => {
    const session = await signIn();
    await enable(session);
    const again = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
    expect(again.body.details.code).toBe('TOTP_ALREADY_ENABLED');
  });

  it('verify without a setup in progress asks to start again', async () => {
    const session = await signIn();
    const res = await authed(request(app).post('/auth/mfa/totp/verify'), session).send({
      code: '123456',
    });
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('TOTP_SETUP_NOT_STARTED');
  });

  it('pins the e2e secret only alongside the test-fixture opt-in', async () => {
    process.env.E2E_TOTP_SECRET_SEED = 'TestSecretTestSecret';
    const pinned = base32Encode(Buffer.from('TestSecretTestSecret'));

    // Without the opt-in the pin is ignored: a hand-started dev server never
    // hands out a predictable secret.
    const session = await signIn();
    const unpinned = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
      password: PASSWORD,
    });
    expect(unpinned.body.secretCode).not.toBe(pinned);

    process.env.ALLOW_TEST_ACCOUNT_PROVISIONING = '1';
    const pinnedRes = await authed(request(app).post('/auth/mfa/totp/setup'), session).send({
      password: PASSWORD,
    });
    expect(pinnedRes.body.secretCode).toBe(pinned);
  });
});

describe('sign-in with an authenticator on', () => {
  it('asks for a code instead of issuing tokens, and the code signs in', async () => {
    const secret = await enable(await signIn());

    const first = await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body.idToken).toBeUndefined();
    expect(first.body.challenge).toBe('SOFTWARE_TOKEN_MFA');

    const done = await request(app)
      .post('/auth/login/mfa')
      .send({
        username: first.body.username,
        session: first.body.session,
        code: totpCode(secret, Date.now()),
      });
    expect(done.status).toBe(200);
    expect(done.body.idToken).toBeTruthy();
    expect(done.body.user.email).toBe(EMAIL);
  });

  it('a wrong code fails, and spends the challenge', async () => {
    const secret = await enable(await signIn());
    const challenge = (
      await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD })
    ).body;

    const wrong = await request(app)
      .post('/auth/login/mfa')
      .send({
        username: challenge.username,
        session: challenge.session,
        code: wrongCode(secret),
      });
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.code).toBe('INVALID_CODE');
    expect(wrong.body.idToken).toBeUndefined();

    const reused = await request(app)
      .post('/auth/login/mfa')
      .send({
        username: challenge.username,
        session: challenge.session,
        code: totpCode(secret, Date.now()),
      });
    expect(reused.status).toBe(401);
    expect(reused.body.details.code).toBe('MFA_SESSION_EXPIRED');
  });

  it('a session for one account cannot be answered as another', async () => {
    const secret = await enable(await signIn());
    const challenge = (
      await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD })
    ).body;
    const res = await request(app)
      .post('/auth/login/mfa')
      .send({
        username: 'someone-else',
        session: challenge.session,
        code: totpCode(secret, Date.now()),
      });
    expect(res.status).toBe(401);
  });
});

describe('turning it off', () => {
  it('needs the password AND a current code, then sign-in is password-only again', async () => {
    const session = await signIn();
    const secret = await enable(session);

    const badPassword = await authed(request(app).post('/auth/mfa/totp/disable'), session).send({
      password: 'nope',
      code: totpCode(secret, Date.now()),
    });
    expect(badPassword.status).toBe(400);
    expect(badPassword.body.details.code).toBe('REAUTH_FAILED');

    const badCode = await authed(request(app).post('/auth/mfa/totp/disable'), session).send({
      password: PASSWORD,
      code: wrongCode(secret),
    });
    expect(badCode.status).toBe(400);
    expect(badCode.body.details.code).toBe('INVALID_CODE');
    expect((await authed(request(app).get('/auth/mfa'), session, false)).body.totp.enabled).toBe(
      true
    );

    const off = await authed(request(app).post('/auth/mfa/totp/disable'), session).send({
      password: PASSWORD,
      code: totpCode(secret, Date.now()),
    });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ totp: { enabled: false } });

    const plain = await request(app).post('/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(plain.body.idToken).toBeTruthy();
  });
});
