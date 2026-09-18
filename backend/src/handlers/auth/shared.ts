/**
 * Pieces the password sign-in (handler.ts) and two-step verification (mfa.ts)
 * both need: turning a Cognito token set into the sign-in response, turning a
 * challenge into the "enter your code" response, proving an access token is
 * the caller's own, and re-authenticating the caller before a factor changes.
 *
 * Nothing here stores, logs or returns an authenticator secret or code.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  type AuthenticationResultType,
  type InitiateAuthCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import createHttpError from 'http-errors';
import type { AuthenticatedEvent } from '../../middleware/auth.js';
import type { MfaChallengeResponse, MfaErrorCode } from '../../models/mfa.js';
import type { PasskeyErrorCode } from '../../models/passkeys.js';
import { cognito, CLIENT_ID } from '../../utils/cognito.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';
import { successResponse } from '../../utils/response.js';

/** A refusal whose `details.code` the client words in the user's language. */
export function mfaError(
  statusCode: number,
  message: string,
  code: MfaErrorCode | PasskeyErrorCode
) {
  return createHttpError(statusCode, message, { details: { code } });
}

/**
 * A Cognito token set → the body `POST /auth/login` has always returned.
 *
 * Two tokens. The ID token rides the Authorization header for all API calls —
 * it's the only one that carries `custom:household_id`, which the
 * requireHousehold middleware reads. The access token is for Cognito-direct
 * calls (ChangePassword, UpdateUserAttributes, the MFA calls) which reject ID
 * tokens.
 */
export async function signedInResponse(
  auth: AuthenticationResultType,
  metadata?: Record<string, unknown>
): Promise<APIGatewayProxyResult> {
  const userResult = await cognito.send(new GetUserCommand({ AccessToken: auth.AccessToken }));

  const attributes = userResult.UserAttributes || [];
  const getAttribute = (name: string) => attributes.find((a) => a.Name === name)?.Value || null;

  const user = {
    id: getAttribute('sub'),
    email: getAttribute('email'),
    name: getAttribute('name'),
    householdId: getAttribute('custom:household_id'),
    householdRole: getAttribute('custom:household_role'),
  };

  audit('auth.login.success', {
    actorId: user.id ?? undefined,
    actorEmail: user.email ?? undefined,
    ...(metadata ? { metadata } : {}),
  });

  return successResponse({
    user,
    idToken: auth.IdToken,
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
    expiresIn: auth.ExpiresIn,
  });
}

/**
 * An InitiateAuth answer that carried a challenge instead of tokens. The one
 * challenge this app answers is Cognito's software-token MFA; anything else
 * is refused by name rather than rendered as a generic 500.
 *
 * `username` is the name Cognito wants back on RespondToAuthChallenge. With
 * email sign-in that is the account's internal username, which Cognito hands
 * over as USER_ID_FOR_SRP; the typed email is only a fallback.
 */
export function challengeResponse(
  result: InitiateAuthCommandOutput,
  typedUsername: string
): APIGatewayProxyResult {
  if (result.ChallengeName === 'SOFTWARE_TOKEN_MFA' && result.Session) {
    const body: MfaChallengeResponse = {
      challenge: 'SOFTWARE_TOKEN_MFA',
      session: result.Session,
      username: result.ChallengeParameters?.USER_ID_FOR_SRP ?? typedUsername,
    };
    return successResponse(body);
  }
  throw unsupportedChallenge(result.ChallengeName);
}

function unsupportedChallenge(challengeName: string | undefined) {
  logger.warn({ challenge: challengeName ?? null }, 'auth.unsupported_challenge');
  return mfaError(
    409,
    'This account needs a sign-in step the app does not support yet. Contact support.',
    'UNSUPPORTED_CHALLENGE'
  );
}

/**
 * The caller's Cognito access token, from `X-Cognito-Access-Token`, after
 * proving it belongs to the same account as the JWT-validated ID token.
 *
 * Without the subject check a caller could present THEIR ID token (passing
 * authMiddleware) alongside someone else's access token and act on that other
 * account with it.
 */
export async function verifiedCallerAccessToken(event: APIGatewayProxyEvent): Promise<string> {
  const ev = event as AuthenticatedEvent;
  // A dedicated header so the Authorization header stays the ID token (which
  // API Gateway's JWT authorizer validates and authMiddleware reads claims
  // from). Cognito's self-service calls reject ID tokens.
  const accessToken =
    event.headers?.['x-cognito-access-token'] ?? event.headers?.['X-Cognito-Access-Token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw createHttpError(401, 'Missing Cognito access token');
  }

  let tokenSub: string | null;
  try {
    const tokenUser = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
    tokenSub =
      tokenUser.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? tokenUser.Username ?? null;
  } catch {
    throw createHttpError(401, 'Invalid Cognito access token');
  }
  if (!tokenSub || tokenSub !== ev.user?.userId) {
    throw createHttpError(403, 'Access token does not match the authenticated user');
  }
  return accessToken;
}

export interface Reauthentication {
  /** Cognito asked for an authenticator code (the account has TOTP on). */
  challenged: boolean;
  /** A fresh access token for the caller, when the sign-in completed. */
  accessToken: string | null;
}

/**
 * Sign the caller in again, from scratch, with their password — and, when the
 * account has an authenticator on, the current code. This is the "prove it is
 * still you" step in front of every change to a sign-in factor.
 *
 * Without a `code`, a challenged sign-in stops at the challenge (no tokens are
 * minted) and reports `challenged: true`; the caller decides what that means.
 * With one, the challenge is answered. Either way the result must be the
 * caller's own account, and the refresh token a completed sign-in mints is
 * revoked at once: it exists only because Cognito's re-authentication IS a
 * sign-in, and it never leaves this Lambda.
 *
 * Wrong password and wrong code are 400s with a code, deliberately not 401s:
 * the client's session is fine, and a 401 on an authenticated route means
 * "your token expired, refresh it".
 */
export async function reauthenticate(
  caller: { userId: string; email: string },
  password: string,
  code?: string
): Promise<Reauthentication> {
  let started: InitiateAuthCommandOutput;
  try {
    started = await cognito.send(
      new InitiateAuthCommand({
        ClientId: CLIENT_ID,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: caller.email, PASSWORD: password },
      })
    );
  } catch (error) {
    if ((error as Error).name === 'NotAuthorizedException') {
      throw mfaError(400, 'That password is not right.', 'REAUTH_FAILED');
    }
    throw error;
  }

  let auth = started.AuthenticationResult;
  let challenged = false;
  if (!auth) {
    if (started.ChallengeName !== 'SOFTWARE_TOKEN_MFA' || !started.Session) {
      throw unsupportedChallenge(started.ChallengeName);
    }
    challenged = true;
    if (code === undefined) return { challenged, accessToken: null };
    try {
      const answered = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: CLIENT_ID,
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: started.Session,
          ChallengeResponses: {
            USERNAME: started.ChallengeParameters?.USER_ID_FOR_SRP ?? caller.email,
            SOFTWARE_TOKEN_MFA_CODE: code,
          },
        })
      );
      auth = answered.AuthenticationResult;
    } catch (error) {
      if ((error as Error).name === 'CodeMismatchException') {
        throw mfaError(400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
      }
      if ((error as Error).name === 'NotAuthorizedException') {
        throw mfaError(400, 'That password or code is not right.', 'REAUTH_FAILED');
      }
      throw error;
    }
  }
  if (!auth?.AccessToken) {
    throw createHttpError(500, 'Re-authentication failed');
  }

  let sub: string | null;
  try {
    const who = await cognito.send(new GetUserCommand({ AccessToken: auth.AccessToken }));
    sub = who.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? who.Username ?? null;
  } finally {
    await revokeQuietly(auth.RefreshToken);
  }
  if (sub !== caller.userId) {
    throw createHttpError(403, 'Re-authenticated account does not match the signed-in user');
  }
  return { challenged, accessToken: auth.AccessToken };
}

/** Best-effort revoke of a refresh token this Lambda minted and will not use. */
async function revokeQuietly(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  try {
    await cognito.send(new RevokeTokenCommand({ ClientId: CLIENT_ID, Token: refreshToken }));
  } catch (error) {
    // Unrevoked, it still expires on its own 30-day clock and was never sent
    // anywhere. Worth a log line, not worth failing the user's change.
    logger.warn({ err: (error as Error).name }, 'auth.reauth_refresh_revoke_failed');
  }
}
