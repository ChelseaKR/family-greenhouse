/**
 * Two-step verification with an authenticator app (#671).
 *
 * Every factor operation is Cognito's own: AssociateSoftwareToken generates
 * and stores the TOTP secret, VerifySoftwareToken checks the first code,
 * SetUserMFAPreference switches the factor on or off, and
 * RespondToAuthChallenge checks the code at sign-in. This Lambda holds no
 * secret, stores nothing, and logs neither a secret nor a code; the secret
 * passes through exactly once, in the setup response, with `no-store`.
 *
 * Re-authentication. Setup asks for the current password; turning the factor
 * off asks for the password AND a current code. Both guard the app's own
 * surface — a person at an unlocked, signed-in device cannot bind their own
 * authenticator, or remove the owner's, through Settings. They are not a hard
 * boundary against a stolen access token: Cognito's public self-service API
 * accepts that token for the same calls directly. That residual is inherent to
 * a public app client, bounded by the one-hour access-token lifetime, and
 * written down in docs/security.md.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AssociateSoftwareTokenCommand,
  RespondToAuthChallengeCommand,
  SetUserMFAPreferenceCommand,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import createHttpError from 'http-errors';
import { authMiddleware, type AuthenticatedEvent } from '../../middleware/auth.js';
import { createHandler } from '../../middleware/handler.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import { validateBody, type ValidatedEvent } from '../../middleware/validation.js';
import {
  loginMfaSchema,
  totpDisableSchema,
  totpSetupSchema,
  totpVerifySchema,
  type LoginMfaInput,
  type MfaStatusResponse,
  type TotpDisableInput,
  type TotpSetupInput,
  type TotpVerifyInput,
} from '../../models/mfa.js';
import { getMfaState } from '../../services/cognitoUsers.js';
import { audit } from '../../utils/auditLog.js';
import { cognito, CLIENT_ID } from '../../utils/cognito.js';
import { successResponse } from '../../utils/response.js';
import {
  challengeResponse,
  mfaError,
  reauthenticate,
  signedInResponse,
  verifiedCallerAccessToken,
} from './shared.js';

/** Shown in the Cognito console against the enrolled factor. */
const DEVICE_NAME = 'Authenticator app';

// POST /auth/login/mfa
//
// The second half of a sign-in `POST /auth/login` answered with a
// SOFTWARE_TOKEN_MFA challenge. A wrong code is a coded 400 (the client may
// have to start the challenge again: Cognito can treat a session as spent
// once a response fails); an expired or reused session is a coded 401.
export const loginMfa = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<LoginMfaInput>;

    let result;
    try {
      result = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: CLIENT_ID,
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: validatedBody.session,
          ChallengeResponses: {
            USERNAME: validatedBody.username,
            SOFTWARE_TOKEN_MFA_CODE: validatedBody.code,
          },
        })
      );
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'CodeMismatchException') {
        audit('auth.login.failure', {
          actorId: validatedBody.username,
          metadata: { reason: 'mfa_code' },
        });
        throw mfaError(400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
      }
      if (name === 'NotAuthorizedException' || name === 'ExpiredCodeException') {
        throw mfaError(
          401,
          'Your sign-in timed out. Enter your password again.',
          'MFA_SESSION_EXPIRED'
        );
      }
      throw error;
    }

    if (!result.AuthenticationResult) {
      // Cognito answered one challenge with another. The same rule as the
      // password step applies: say which, never a bare 500.
      return challengeResponse(result, validatedBody.username);
    }
    return signedInResponse(result.AuthenticationResult, { mfa: 'totp' });
  }
)
  .use(authRateLimit())
  .use(validateBody(loginMfaSchema));

// GET /auth/mfa
export const getMfaStatus = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const state = await getMfaState(user.userId);
    const body: MfaStatusResponse = { totp: { enabled: state.totpEnabled } };
    return successResponse(body);
  }
).use(authMiddleware());

// POST /auth/mfa/totp/setup
export const startTotpSetup = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<TotpSetupInput>;
    const accessToken = await verifiedCallerAccessToken(event);

    // Password only: an account that already has an authenticator stops at
    // Cognito's challenge, which is exactly the "already on" answer. Replacing
    // an authenticator is turn-off-then-set-up, so the old one is proven first.
    const reauth = await reauthenticate(user, validatedBody.password);
    if (reauth.challenged) {
      throw mfaError(
        409,
        'An authenticator app is already on for this account. Turn it off first to replace it.',
        'TOTP_ALREADY_ENABLED'
      );
    }

    const associated = await cognito.send(
      new AssociateSoftwareTokenCommand({ AccessToken: accessToken })
    );
    if (!associated.SecretCode) {
      throw createHttpError(502, 'Cognito did not return an authenticator secret');
    }

    audit('auth.mfa.totp_setup_started', { actorId: user.userId, actorEmail: user.email });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // The secret is the factor. No browser, proxy or CDN keeps a copy.
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ secretCode: associated.SecretCode }),
    };
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(totpSetupSchema));

// POST /auth/mfa/totp/verify
export const verifyTotpSetup = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<TotpVerifyInput>;
    const accessToken = await verifiedCallerAccessToken(event);

    let status: string | undefined;
    try {
      const verified = await cognito.send(
        new VerifySoftwareTokenCommand({
          AccessToken: accessToken,
          UserCode: validatedBody.code,
          FriendlyDeviceName: DEVICE_NAME,
        })
      );
      status = verified.Status;
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'CodeMismatchException' || name === 'EnableSoftwareTokenMFAException') {
        throw mfaError(400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
      }
      if (name === 'InvalidParameterException') {
        throw mfaError(409, 'Start the setup again.', 'TOTP_SETUP_NOT_STARTED');
      }
      throw error;
    }
    if (status !== 'SUCCESS') {
      throw mfaError(400, 'That code did not match. Try the newest one.', 'INVALID_CODE');
    }

    // Verified is not enabled: Cognito records the authenticator on a
    // successful verify but only asks for it at sign-in once the preference
    // is set. Both happen here, so a 200 always means "on".
    await cognito.send(
      new SetUserMFAPreferenceCommand({
        AccessToken: accessToken,
        SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
      })
    );

    audit('auth.mfa.totp_enabled', { actorId: user.userId, actorEmail: user.email });
    const body: MfaStatusResponse = { totp: { enabled: true } };
    return successResponse(body);
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(totpVerifySchema));

// POST /auth/mfa/totp/disable
export const disableTotp = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<TotpDisableInput>;

    const reauth = await reauthenticate(user, validatedBody.password, validatedBody.code);
    if (!reauth.accessToken) {
      throw createHttpError(500, 'Re-authentication failed');
    }

    // The fresh token from the re-authentication, not the session's: the
    // change is made by the sign-in that just proved both factors.
    await cognito.send(
      new SetUserMFAPreferenceCommand({
        AccessToken: reauth.accessToken,
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      })
    );

    audit('auth.mfa.totp_disabled', {
      actorId: user.userId,
      actorEmail: user.email,
      metadata: { wasChallenged: reauth.challenged },
    });
    const body: MfaStatusResponse = { totp: { enabled: false } };
    return successResponse(body);
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(totpDisableSchema));
