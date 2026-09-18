/**
 * Local dev-server mirror of handlers/auth/passkeys.ts (#671, second half).
 *
 * The availability probe reports PASSKEYS_ENABLED=1 — the same switch the auth
 * Lambda reads — so by default the mock answers as a production deployment
 * without passkeys does, and the sign-in page other specs screenshot is
 * unchanged. The passkey ROUTES answer when that switch is on, or under the
 * test-fixture opt-in (ALLOW_TEST_ACCOUNT_PROVISIONING=1, set only by the
 * Playwright webServer), so tests/e2e/passkeys.spec.ts can exercise them by
 * answering the probe for its own page. Otherwise: 404 PASSKEYS_DISABLED.
 *
 * WHAT THIS MOCK CHECKS, AND WHAT IT DOES NOT. Production's checks are
 * Cognito's: attestation, origin, relying-party ID, challenge and signature.
 * This mock checks the parts that exercise the CLIENT: that the browser's JSON
 * is the WebAuthn Level 3 shape, that `clientDataJSON` carries the right
 * ceremony type and the exact challenge this server issued, and that a
 * sign-in names a credential this account registered. It does not verify
 * signatures or attestation statements — it never ships, and pretending to
 * would only add a crypto implementation nobody should trust. The e2e drives
 * a real browser WebAuthn stack (Chromium's virtual authenticator), so the
 * serialization it tests is the real one.
 */
import type express from 'express';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  passkeyRegisterFinishSchema,
  passkeyRegisterStartSchema,
  passkeySignInFinishSchema,
  passkeySignInStartSchema,
  passkeysEnabled,
  type PasskeyErrorCode,
  type PasskeySummary,
} from './models/passkeys.js';

/** The relying party a browser at http://localhost:3000 may use. */
const MOCK_RP_ID = 'localhost';
const CEREMONY_TTL_MS = 3 * 60_000;

interface StoredPasskey extends PasskeySummary {
  userId: string;
}

const passkeys = new Map<string, StoredPasskey>(); // credential id -> passkey
const registrations = new Map<string, { challenge: string; expiresAt: number }>(); // userId
const signIns = new Map<string, { userId: string; challenge: string; expiresAt: number }>(); // session

export function resetPasskeyState(): void {
  passkeys.clear();
  registrations.clear();
  signIns.clear();
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function readClientData(credential: {
  response: Record<string, unknown>;
}): { type?: unknown; challenge?: unknown } | null {
  const raw = credential.response.clientDataJSON;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      type?: unknown;
      challenge?: unknown;
    };
  } catch {
    return null;
  }
}

export interface PasskeyMockUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

export interface PasskeyDeps {
  authMiddleware: express.RequestHandler;
  validateBody: (schema: z.ZodTypeAny) => express.RequestHandler;
  getUser: (userId: string) => PasskeyMockUser | undefined;
  findUserByEmail: (email: string) => PasskeyMockUser | undefined;
  /** local-server-mfa.ts: is an authenticator app on for this user? */
  isTotpEnabled: (userId: string) => boolean;
  /** local-server-mfa.ts: does this code match the user's authenticator now? */
  totpCodeMatches: (userId: string, code: string) => boolean;
  signInBody: (userId: string) => unknown;
}

function refuse(res: express.Response, status: number, message: string, code: PasskeyErrorCode) {
  return res.status(status).json({ message, details: { code } });
}

function body<T>(req: express.Request): T {
  return (req as unknown as { validatedBody: T }).validatedBody;
}

function callerId(req: express.Request): string {
  return (req as unknown as { user: { userId: string } }).user.userId;
}

/** Mirrors verifiedCallerAccessToken (see local-server-mfa.ts). */
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

export function registerPasskeyRoutes(app: express.Express, deps: PasskeyDeps): void {
  const { authMiddleware, validateBody, getUser, findUserByEmail, signInBody } = deps;

  const disabled = (res: express.Response) =>
    refuse(res, 404, 'Passkeys are not available yet.', 'PASSKEYS_DISABLED');
  const routesOn = () => passkeysEnabled() || process.env.ALLOW_TEST_ACCOUNT_PROVISIONING === '1';

  app.get('/auth/passkeys/available', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ available: passkeysEnabled() });
  });

  app.post('/auth/login/passkey/start', validateBody(passkeySignInStartSchema), (req, res) => {
    if (!routesOn()) return disabled(res);
    const { email } = body<z.infer<typeof passkeySignInStartSchema>>(req);
    const user = findUserByEmail(email);
    const mine = user ? [...passkeys.values()].filter((p) => p.userId === user.id) : [];
    if (!user || mine.length === 0) {
      return refuse(res, 409, 'There is no passkey for this account yet.', 'NO_PASSKEY');
    }
    const challenge = b64url(randomBytes(32));
    const session = `mock-passkey-session-${randomBytes(16).toString('hex')}`;
    signIns.set(session, { userId: user.id, challenge, expiresAt: Date.now() + CEREMONY_TTL_MS });
    return res.json({
      session,
      username: user.id,
      options: {
        challenge,
        rpId: MOCK_RP_ID,
        timeout: 180_000,
        userVerification: 'preferred',
        allowCredentials: mine.map((p) => ({ type: 'public-key', id: p.id })),
      },
    });
  });

  app.post('/auth/login/passkey/finish', validateBody(passkeySignInFinishSchema), (req, res) => {
    if (!routesOn()) return disabled(res);
    const { username, session, credential } = body<z.infer<typeof passkeySignInFinishSchema>>(req);
    const pending = signIns.get(session);
    signIns.delete(session);
    if (!pending || pending.expiresAt < Date.now() || pending.userId !== username) {
      return refuse(res, 401, 'That took too long. Try the passkey again.', 'PASSKEY_EXPIRED');
    }
    const clientData = readClientData(credential);
    const stored = passkeys.get(credential.id);
    if (
      clientData?.type !== 'webauthn.get' ||
      clientData.challenge !== pending.challenge ||
      !stored ||
      stored.userId !== pending.userId
    ) {
      return refuse(
        res,
        401,
        'That passkey did not work. Try again, or sign in with your password.',
        'PASSKEY_REJECTED'
      );
    }
    return res.json(signInBody(pending.userId));
  });

  app.get('/auth/passkeys', authMiddleware, (req, res) => {
    if (!routesOn()) return disabled(res);
    if (!checkAccessToken(req, res)) return;
    const userId = callerId(req);
    const mine: PasskeySummary[] = [...passkeys.values()]
      .filter((p) => p.userId === userId)
      .map(({ id, name, createdAt, attachment }) => ({ id, name, createdAt, attachment }));
    return res.json({ passkeys: mine });
  });

  app.post(
    '/auth/passkeys/register/start',
    authMiddleware,
    validateBody(passkeyRegisterStartSchema),
    (req, res) => {
      if (!routesOn()) return disabled(res);
      if (!checkAccessToken(req, res)) return;
      const userId = callerId(req);
      const user = getUser(userId);
      const { password, code } = body<z.infer<typeof passkeyRegisterStartSchema>>(req);
      if (!user || user.password !== password) {
        return res
          .status(400)
          .json({ message: 'That password is not right.', details: { code: 'REAUTH_FAILED' } });
      }
      if (deps.isTotpEnabled(userId)) {
        if (!code) {
          return refuse(
            res,
            400,
            'Enter a code from your authenticator app as well.',
            'CODE_REQUIRED'
          );
        }
        if (!deps.totpCodeMatches(userId, code)) {
          return res.status(400).json({
            message: 'That code did not match. Try the newest one.',
            details: { code: 'INVALID_CODE' },
          });
        }
      }
      const challenge = b64url(randomBytes(32));
      registrations.set(userId, { challenge, expiresAt: Date.now() + CEREMONY_TTL_MS });
      const existing = [...passkeys.values()].filter((p) => p.userId === userId);
      return res.json({
        options: {
          challenge,
          rp: { id: MOCK_RP_ID, name: 'Family Greenhouse' },
          user: { id: b64url(Buffer.from(userId)), name: user.email, displayName: user.name },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 180_000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          excludeCredentials: existing.map((p) => ({ type: 'public-key', id: p.id })),
        },
      });
    }
  );

  app.post(
    '/auth/passkeys/register/finish',
    authMiddleware,
    validateBody(passkeyRegisterFinishSchema),
    (req, res) => {
      if (!routesOn()) return disabled(res);
      if (!checkAccessToken(req, res)) return;
      const userId = callerId(req);
      const pending = registrations.get(userId);
      registrations.delete(userId);
      if (!pending || pending.expiresAt < Date.now()) {
        return refuse(res, 409, 'That took too long. Add the passkey again.', 'PASSKEY_EXPIRED');
      }
      const { credential } = body<z.infer<typeof passkeyRegisterFinishSchema>>(req);
      const clientData = readClientData(credential);
      if (
        clientData?.type !== 'webauthn.create' ||
        clientData.challenge !== pending.challenge ||
        typeof credential.response.attestationObject !== 'string'
      ) {
        return refuse(res, 400, 'That passkey could not be added.', 'PASSKEY_REJECTED');
      }
      const attachment = (credential as { authenticatorAttachment?: unknown })
        .authenticatorAttachment;
      passkeys.set(credential.id, {
        id: credential.id,
        userId,
        name: 'Passkey',
        createdAt: new Date().toISOString(),
        attachment: typeof attachment === 'string' ? attachment : null,
      });
      return res.status(201).json({ added: true });
    }
  );

  app.delete('/auth/passkeys/:credentialId', authMiddleware, (req, res) => {
    if (!routesOn()) return disabled(res);
    if (!checkAccessToken(req, res)) return;
    const stored = passkeys.get(String(req.params.credentialId));
    if (!stored || stored.userId !== callerId(req)) {
      return res.status(404).json({ message: 'That passkey was not found' });
    }
    passkeys.delete(stored.id);
    return res.status(204).end();
  });
}
