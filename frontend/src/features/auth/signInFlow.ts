/**
 * The sign-in flow as one small, unit-tested state machine (#671), shared by
 * the real Cognito-backed API and the local mock server — both speak the same
 * wire contract (backend/src/models/mfa.ts), and the page only renders states.
 *
 *   credentials ──password──▶ signed in
 *        │
 *        └──────password──▶ code (challenge) ──code──▶ signed in
 *                                  ▲    │
 *                                  └────┘ wrong code: new challenge next try
 *
 * Why a wrong code re-starts the challenge: Cognito may treat a challenge
 * session as spent once a response to it fails, and the client cannot tell
 * whether it did. So after a wrong code the next attempt first asks for a
 * fresh challenge with the credentials still held in the form. The same move
 * covers a session that simply expired (three minutes): one transparent
 * re-challenge, then the code the person typed is tried against it.
 *
 * The password is never stored by this module; the caller passes the form's
 * own values in, and they go no further than the page already sends them.
 */
import axios from 'axios';
import {
  isMfaChallenge,
  type AuthResponse,
  type LoginCredentials,
  type LoginResult,
  type MfaChallenge,
} from '@/services/authService';

export interface SignInApi {
  login(credentials: LoginCredentials): Promise<LoginResult>;
  completeMfaSignIn(input: {
    username: string;
    session: string;
    code: string;
  }): Promise<AuthResponse>;
}

export type SignInState =
  | { step: 'credentials' }
  | {
      step: 'code';
      challenge: MfaChallenge;
      /** A code was already refused against this challenge. */
      spent: boolean;
    };

export type SignInOutcome =
  | { kind: 'signedIn'; auth: AuthResponse }
  | { kind: 'needsCode'; state: Extract<SignInState, { step: 'code' }> }
  | { kind: 'wrongCode'; state: Extract<SignInState, { step: 'code' }> };

export type MfaErrorCode =
  | 'REAUTH_FAILED'
  | 'INVALID_CODE'
  | 'MFA_SESSION_EXPIRED'
  | 'TOTP_ALREADY_ENABLED'
  | 'TOTP_SETUP_NOT_STARTED'
  | 'UNSUPPORTED_CHALLENGE';

const MFA_ERROR_CODES: ReadonlySet<string> = new Set<MfaErrorCode>([
  'REAUTH_FAILED',
  'INVALID_CODE',
  'MFA_SESSION_EXPIRED',
  'TOTP_ALREADY_ENABLED',
  'TOTP_SETUP_NOT_STARTED',
  'UNSUPPORTED_CHALLENGE',
]);

/** The `details.code` of a two-step-verification refusal, or null. */
export function readMfaErrorCode(error: unknown): MfaErrorCode | null {
  if (!axios.isAxiosError(error)) return null;
  const details = (error.response?.data as { details?: unknown } | undefined)?.details;
  if (!details || typeof details !== 'object') return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && MFA_ERROR_CODES.has(code) ? (code as MfaErrorCode) : null;
}

/** Authenticator apps show "123 456"; the API wants "123456". */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, '');
}

function toOutcome(result: LoginResult): SignInOutcome {
  return isMfaChallenge(result)
    ? { kind: 'needsCode', state: { step: 'code', challenge: result, spent: false } }
    : { kind: 'signedIn', auth: result };
}

/** The password step. */
export async function submitCredentials(
  api: SignInApi,
  credentials: LoginCredentials
): Promise<SignInOutcome> {
  return toOutcome(await api.login(credentials));
}

/**
 * The code step. Resolves with the next state; rejects only with errors the
 * page shows as they are (a refused password on a re-challenge, a network
 * failure, a second expiry).
 */
export async function submitCode(
  api: SignInApi,
  credentials: LoginCredentials,
  state: Extract<SignInState, { step: 'code' }>,
  rawCode: string
): Promise<SignInOutcome> {
  const code = normalizeCode(rawCode);
  let challenge = state.challenge;
  let rechallenged = false;

  const rechallenge = async (): Promise<SignInOutcome | null> => {
    rechallenged = true;
    const fresh = await api.login(credentials);
    if (!isMfaChallenge(fresh)) return { kind: 'signedIn', auth: fresh };
    challenge = fresh;
    return null;
  };

  if (state.spent) {
    const done = await rechallenge();
    if (done) return done;
  }

  for (;;) {
    try {
      const auth = await api.completeMfaSignIn({
        username: challenge.username,
        session: challenge.session,
        code,
      });
      return { kind: 'signedIn', auth };
    } catch (error) {
      const reason = readMfaErrorCode(error);
      if (reason === 'INVALID_CODE') {
        return { kind: 'wrongCode', state: { step: 'code', challenge, spent: true } };
      }
      if (reason === 'MFA_SESSION_EXPIRED' && !rechallenged) {
        const done = await rechallenge();
        if (done) return done;
        continue;
      }
      throw error;
    }
  }
}
