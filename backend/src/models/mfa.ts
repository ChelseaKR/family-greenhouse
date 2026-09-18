/**
 * Two-step verification (#671): the wire contract the auth Lambda
 * (handlers/auth/mfa.ts) and the local mock server (local-server-mfa.ts)
 * share, so the two cannot drift on a field name or an error code.
 *
 * The factor itself is Cognito's software-token MFA (TOTP). Cognito generates
 * the shared secret, stores it, and checks every code; this app never keeps a
 * copy. The secret crosses the API exactly once, in the response to
 * `POST /auth/mfa/totp/setup`, so the browser can draw the QR code.
 */
import { z } from 'zod';

/** A 6-digit authenticator code. The client strips the space apps show. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/**
 * Cognito's MFA session strings are opaque and ~1 KB. 4096 caps an abusive
 * payload without ever rejecting a real one (same bound as refresh tokens).
 */
const cognitoSessionSchema = z.string().min(1).max(4096);

/** POST /auth/login/mfa — the second half of a sign-in Cognito challenged. */
export const loginMfaSchema = z.object({
  /** The username Cognito named in the challenge (echoed back verbatim). */
  username: z.string().min(1).max(256),
  session: cognitoSessionSchema,
  code: totpCodeSchema,
});

/**
 * POST /auth/mfa/totp/setup — enrollment starts with the current password.
 * A stolen session must not be able to bind the attacker's authenticator to
 * the account, which would lock the real owner out of their own sign-in.
 */
export const totpSetupSchema = z.object({
  password: z.string().min(1).max(256),
});

/** POST /auth/mfa/totp/verify — the first code from the new authenticator. */
export const totpVerifySchema = z.object({
  code: totpCodeSchema,
});

/**
 * POST /auth/mfa/totp/disable — a full re-authentication: the password AND a
 * current code. Turning the factor off is the one change an attacker holding
 * only a session most wants to make.
 */
export const totpDisableSchema = z.object({
  password: z.string().min(1).max(256),
  code: totpCodeSchema,
});

export type LoginMfaInput = z.infer<typeof loginMfaSchema>;
export type TotpSetupInput = z.infer<typeof totpSetupSchema>;
export type TotpVerifyInput = z.infer<typeof totpVerifySchema>;
export type TotpDisableInput = z.infer<typeof totpDisableSchema>;

/**
 * `details.code` values on the refusals the client words in the user's
 * language. Anything else stays an ordinary error message.
 */
export const MFA_ERROR_CODES = [
  /** The password (or password + code) given to re-authenticate was wrong. */
  'REAUTH_FAILED',
  /** An authenticator code did not match. */
  'INVALID_CODE',
  /** The sign-in challenge expired or was already used; start again. */
  'MFA_SESSION_EXPIRED',
  /** Setup was asked for while an authenticator is already on. */
  'TOTP_ALREADY_ENABLED',
  /** Verify was asked for with no setup in progress. */
  'TOTP_SETUP_NOT_STARTED',
  /** Cognito asked for a sign-in step this app does not implement. */
  'UNSUPPORTED_CHALLENGE',
] as const;

export type MfaErrorCode = (typeof MFA_ERROR_CODES)[number];

/** What `POST /auth/login` returns in place of tokens when a code is needed. */
export interface MfaChallengeResponse {
  challenge: 'SOFTWARE_TOKEN_MFA';
  session: string;
  username: string;
}

/** GET /auth/mfa */
export interface MfaStatusResponse {
  totp: { enabled: boolean };
}
