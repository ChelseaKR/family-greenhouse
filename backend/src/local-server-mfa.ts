/**
 * Local dev-server mirror of handlers/auth/mfa.ts — two-step verification with
 * an authenticator app (#671).
 *
 * Production never runs this: there, Cognito generates and stores the TOTP
 * secret and checks every code, and the Lambda holds nothing. This in-memory
 * stand-in exists so the flows are testable offline (the integration suite and
 * the Playwright e2e run against this server), so it has to CHECK codes the way
 * Cognito does — a mock that accepted any six digits would let a broken client
 * pass. Hence the small RFC 6238 implementation below, tested against the
 * RFCs' own vectors (tests/integration/mfa.test.ts). It is dev-only code,
 * never bundled into a Lambda.
 *
 * Same contract note as the rest of the mock: every status, body shape and
 * `details.code` mirrors the production handler.
 *
 * Sessions are single-use and expire after three minutes, matching Cognito's
 * default auth-session validity. A failed code spends the session, which is the
 * stricter of the two behaviors Cognito can show; the client's sign-in flow
 * (frontend/src/features/auth/signInFlow.ts) starts a fresh challenge after a
 * wrong code either way, so it works against both.
 */
import type express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import {
  loginMfaSchema,
  totpDisableSchema,
  totpSetupSchema,
  totpVerifySchema,
  type MfaChallengeResponse,
  type MfaErrorCode,
} from './models/mfa.js';

// ---------------------------------------------------------------------------
// RFC 4648 base32 + RFC 6238 TOTP (SHA-1, 6 digits, 30-second step) — the
// parameters Cognito and every mainstream authenticator app use.
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) over a raw key, truncated to `digits`. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code a base32-secret authenticator shows at `atMs`. */
export function totpCode(secretBase32: string, atMs: number, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / 30), digits);
}

/** Accepts the current step and one either side, as Cognito tolerates clock skew. */
export function totpMatches(secretBase32: string, code: string, atMs: number): boolean {
  const expected = Buffer.from(code);
  for (const drift of [-1, 0, 1]) {
    const candidate = Buffer.from(totpCode(secretBase32, atMs + drift * 30_000));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface TotpState {
  /** The enabled authenticator's secret — Cognito's copy, in production. */
  secret: string | null;
  /** Issued by setup, not yet proven by a code. */
  pending: string | null;
}

interface ChallengeSession {
  userId: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 3 * 60_000;
const totp = new Map<string, TotpState>();
const sessions = new Map<string, ChallengeSession>();

/** Called by local-server.ts `resetDb` so no test inherits another's factor. */
export function resetMfaState(): void {
  totp.clear();
  sessions.clear();
}

/**
 * The secret setup hands out. Random, as Cognito's is — except that the
 * Playwright webServer may pin one so the e2e can compute codes from a known
 * key. The pin is a readable seed phrase (`E2E_TOTP_SECRET_SEED`), not a
 * key-shaped literal, and the secret is its base32 form. It is honoured only
 * alongside the existing test-fixture opt-in, so a dev server started by hand
 * never issues a predictable secret.
 */
function issueSecret(): string {
  const seed = process.env.E2E_TOTP_SECRET_SEED;
  if (seed && process.env.ALLOW_TEST_ACCOUNT_PROVISIONING === '1') {
    return base32Encode(Buffer.from(seed));
  }
  return base32Encode(randomBytes(20));
}

export function isTotpEnabled(userId: string): boolean {
  return Boolean(totp.get(userId)?.secret);
}

/** For the passkey mock's re-authentication: does `code` match right now? */
export function totpCodeMatchesFor(userId: string, code: string): boolean {
  const secret = totp.get(userId)?.secret;
  return Boolean(secret) && totpMatches(secret as string, code, Date.now());
}

/**
 * What the mock's `POST /auth/login` returns in place of tokens when the
 * account has an authenticator on — or null to sign in as before. Mirrors
 * `challengeResponse` in handlers/auth/shared.ts; `username` is the internal
 * id, as Cognito's USER_ID_FOR_SRP is.
 */
export function beginMfaSignIn(userId: string): MfaChallengeResponse | null {
  if (!isTotpEnabled(userId)) return null;
  const session = `mock-mfa-session-${randomBytes(16).toString('hex')}`;
  sessions.set(session, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return { challenge: 'SOFTWARE_TOKEN_MFA', session, username: userId };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface MfaMockUser {
  id: string;
  email: string;
  password: string;
}

export interface MfaDeps {
  authMiddleware: express.RequestHandler;
  validateBody: (schema: z.ZodTypeAny) => express.RequestHandler;
  getUser: (userId: string) => MfaMockUser | undefined;
  /** The mock's full sign-in response body (user + tokens), as /auth/login sends. */
  signInBody: (userId: string) => unknown;
}

function refuse(res: express.Response, status: number, message: string, code: MfaErrorCode) {
  return res.status(status).json({ message, details: { code } });
}

function body<T>(req: express.Request): T {
  return (req as unknown as { validatedBody: T }).validatedBody;
}

function callerId(req: express.Request): string {
  return (req as unknown as { user: { userId: string } }).user.userId;
}

/**
 * Mirrors verifiedCallerAccessToken: the X-Cognito-Access-Token header must be
 * present and name the same account as the Authorization token.
 */
function checkAccessToken(req: express.Request, res: express.Response): boolean {
  const header = req.headers['x-cognito-access-token'];
  if (typeof header !== 'string' || header.length === 0) {
    res.status(401).json({ message: 'Missing Cognito access token' });
    return false;
  }
  const parts = header.split('-');
  if (parts.length < 4 || parts[0] !== 'mock' || parts[1] !== 'token') {
    res.status(401).json({ message: 'Invalid Cognito access token' });
    return false;
  }
  if (parts.slice(2, -1).join('-') !== callerId(req)) {
    res.status(403).json({ message: 'Access token does not match the authenticated user' });
    return false;
  }
  return true;
}

export function registerMfaRoutes(app: express.Express, deps: MfaDeps): void {
  const { authMiddleware, validateBody, getUser, signInBody } = deps;

  app.post('/auth/login/mfa', validateBody(loginMfaSchema), (req, res) => {
    const { username, session, code } = body<z.infer<typeof loginMfaSchema>>(req);
    const found = sessions.get(session);
    // Single use, success or failure (see the module note).
    sessions.delete(session);
    if (!found || found.expiresAt < Date.now() || found.userId !== username) {
      return refuse(
        res,
        401,
        'Your sign-in timed out. Enter your password again.',
        'MFA_SESSION_EXPIRED'
      );
    }
    const secret = totp.get(found.userId)?.secret;
    if (!secret || !totpMatches(secret, code, Date.now())) {
      return refuse(res, 400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
    }
    return res.json(signInBody(found.userId));
  });

  app.get('/auth/mfa', authMiddleware, (req, res) => {
    res.json({ totp: { enabled: isTotpEnabled(callerId(req)) } });
  });

  app.post('/auth/mfa/totp/setup', authMiddleware, validateBody(totpSetupSchema), (req, res) => {
    if (!checkAccessToken(req, res)) return;
    const userId = callerId(req);
    const user = getUser(userId);
    const { password } = body<z.infer<typeof totpSetupSchema>>(req);
    if (!user || user.password !== password) {
      return refuse(res, 400, 'That password is not right.', 'REAUTH_FAILED');
    }
    if (isTotpEnabled(userId)) {
      return refuse(
        res,
        409,
        'An authenticator app is already on for this account. Turn it off first to replace it.',
        'TOTP_ALREADY_ENABLED'
      );
    }
    const secretCode = issueSecret();
    totp.set(userId, { secret: null, pending: secretCode });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ secretCode });
  });

  app.post('/auth/mfa/totp/verify', authMiddleware, validateBody(totpVerifySchema), (req, res) => {
    if (!checkAccessToken(req, res)) return;
    const userId = callerId(req);
    const state = totp.get(userId);
    const { code } = body<z.infer<typeof totpVerifySchema>>(req);
    if (!state?.pending) {
      return refuse(res, 409, 'Start the setup again.', 'TOTP_SETUP_NOT_STARTED');
    }
    if (!totpMatches(state.pending, code, Date.now())) {
      return refuse(res, 400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
    }
    totp.set(userId, { secret: state.pending, pending: null });
    return res.json({ totp: { enabled: true } });
  });

  app.post(
    '/auth/mfa/totp/disable',
    authMiddleware,
    validateBody(totpDisableSchema),
    (req, res) => {
      const userId = callerId(req);
      const user = getUser(userId);
      const { password, code } = body<z.infer<typeof totpDisableSchema>>(req);
      if (!user || user.password !== password) {
        return refuse(res, 400, 'That password is not right.', 'REAUTH_FAILED');
      }
      const secret = totp.get(userId)?.secret;
      if (secret && !totpMatches(secret, code, Date.now())) {
        return refuse(res, 400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
      }
      totp.delete(userId);
      return res.json({ totp: { enabled: false } });
    }
  );
}
