/**
 * Passkeys on Cognito's native WebAuthn (#671, second half).
 *
 * Registration: StartWebAuthnRegistration issues the creation options,
 * the browser makes the credential, CompleteWebAuthnRegistration verifies and
 * stores it. Sign-in: InitiateAuth with the choice-based USER_AUTH flow and
 * PREFERRED_CHALLENGE=WEB_AUTHN issues the request options, the browser
 * signs, RespondToAuthChallenge verifies. List and remove are
 * ListWebAuthnCredentials / DeleteWebAuthnCredential. Every check that
 * matters — origin, relying-party ID, challenge, signature, attestation — is
 * Cognito's; this Lambda validates only the shape and size of what it
 * forwards, and stores nothing.
 *
 * INERT UNTIL THE OWNER APPLIES IT. Nothing here runs unless the auth Lambda
 * has PASSKEYS_ENABLED=1, which Terraform sets only with `passkeys_enabled =
 * true` — the same switch that gives the pool its web_authn_configuration and
 * WEB_AUTHN sign-in factor. Off, every route but the availability probe
 * answers 404 PASSKEYS_DISABLED.
 *
 * Adding a passkey re-authenticates first (password, plus a code when an
 * authenticator app is on): a new sign-in method is exactly what someone at
 * an unlocked, signed-in device would add to keep a way in. Removing one does
 * not — removal can only take a way in away, and the password remains.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CompleteWebAuthnRegistrationCommand,
  DeleteWebAuthnCredentialCommand,
  InitiateAuthCommand,
  ListWebAuthnCredentialsCommand,
  RespondToAuthChallengeCommand,
  StartWebAuthnRegistrationCommand,
  type CompleteWebAuthnRegistrationCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';
import createHttpError from 'http-errors';
import { authMiddleware, type AuthenticatedEvent } from '../../middleware/auth.js';
import { createHandler } from '../../middleware/handler.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import { validateBody, type ValidatedEvent } from '../../middleware/validation.js';
import {
  passkeyRegisterFinishSchema,
  passkeyRegisterStartSchema,
  passkeySignInFinishSchema,
  passkeySignInStartSchema,
  passkeysEnabled,
  type PasskeyRegisterFinishInput,
  type PasskeyRegisterStartInput,
  type PasskeySignInChallenge,
  type PasskeySignInFinishInput,
  type PasskeySignInStartInput,
  type PasskeySummary,
} from '../../models/passkeys.js';
import { audit } from '../../utils/auditLog.js';
import { cognito, CLIENT_ID } from '../../utils/cognito.js';
import { cacheableResponse, successResponse, noContentResponse } from '../../utils/response.js';
import {
  challengeResponse,
  mfaError,
  reauthenticate,
  signedInResponse,
  verifiedCallerAccessToken,
} from './shared.js';

function requireEnabled(): void {
  if (!passkeysEnabled()) {
    throw mfaError(404, 'Passkeys are not available yet.', 'PASSKEYS_DISABLED');
  }
}

/** Cognito's WebAuthn refusals, by exception name. */
const REJECTED = new Set([
  'WebAuthnClientMismatchException',
  'WebAuthnCredentialNotSupportedException',
  'WebAuthnNotEnabledException',
  'WebAuthnOriginNotAllowedException',
  'WebAuthnRelyingPartyMismatchException',
  'WebAuthnConfigurationMissingException',
]);

function parseOptions(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
  throw createHttpError(502, 'Cognito returned no passkey options');
}

// GET /auth/passkeys/available
//
// Public, and the only passkey route that answers when they are off: the
// sign-in page asks it before offering "Use a passkey", so a deployment
// without passkeys shows no control rather than a broken one.
export const passkeysAvailable = createHandler((): Promise<APIGatewayProxyResult> =>
  Promise.resolve(
    cacheableResponse(
      { available: passkeysEnabled() },
      { maxAgeSeconds: 300, visibility: 'public' }
    )
  )
);

// POST /auth/login/passkey/start
export const passkeySignInStart = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    requireEnabled();
    const { validatedBody } = event as ValidatedEvent<PasskeySignInStartInput>;

    let result;
    try {
      result = await cognito.send(
        new InitiateAuthCommand({
          ClientId: CLIENT_ID,
          AuthFlow: 'USER_AUTH',
          AuthParameters: { USERNAME: validatedBody.email, PREFERRED_CHALLENGE: 'WEB_AUTHN' },
        })
      );
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'UserNotConfirmedException') {
        throw createHttpError(401, 'Please confirm your email first');
      }
      if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
        throw mfaError(409, 'There is no passkey for this account yet.', 'NO_PASSKEY');
      }
      throw error;
    }

    const options = result.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS;
    if (result.ChallengeName !== 'WEB_AUTHN' || !result.Session || !options) {
      // No passkey registered (Cognito offers the other factors instead), or
      // no such account — deliberately the same answer, so this route tells
      // no one which emails have accounts.
      throw mfaError(409, 'There is no passkey for this account yet.', 'NO_PASSKEY');
    }

    const body: PasskeySignInChallenge = {
      session: result.Session,
      username:
        result.ChallengeParameters?.USER_ID_FOR_SRP ??
        result.ChallengeParameters?.USERNAME ??
        validatedBody.email,
      options: parseOptions(options),
    };
    return successResponse(body);
  }
)
  .use(authRateLimit())
  .use(validateBody(passkeySignInStartSchema));

// POST /auth/login/passkey/finish
export const passkeySignInFinish = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    requireEnabled();
    const { validatedBody } = event as ValidatedEvent<PasskeySignInFinishInput>;

    let result;
    try {
      result = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: CLIENT_ID,
          ChallengeName: 'WEB_AUTHN',
          Session: validatedBody.session,
          ChallengeResponses: {
            USERNAME: validatedBody.username,
            CREDENTIAL: JSON.stringify(validatedBody.credential),
          },
        })
      );
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'ExpiredCodeException') {
        throw mfaError(401, 'That took too long. Try the passkey again.', 'PASSKEY_EXPIRED');
      }
      if (name === 'NotAuthorizedException' || REJECTED.has(name)) {
        audit('auth.login.failure', {
          actorId: validatedBody.username,
          metadata: { reason: 'passkey' },
        });
        throw mfaError(
          401,
          'That passkey did not work. Try again, or sign in with your password.',
          'PASSKEY_REJECTED'
        );
      }
      throw error;
    }

    if (!result.AuthenticationResult) {
      return challengeResponse(result, validatedBody.username);
    }
    return signedInResponse(result.AuthenticationResult, { method: 'passkey' });
  }
)
  .use(authRateLimit())
  .use(validateBody(passkeySignInFinishSchema));

// GET /auth/passkeys
export const listPasskeys = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    requireEnabled();
    const accessToken = await verifiedCallerAccessToken(event);
    const listed = await cognito.send(
      new ListWebAuthnCredentialsCommand({ AccessToken: accessToken, MaxResults: 20 })
    );
    const passkeys: PasskeySummary[] = (listed.Credentials ?? []).map((c) => ({
      id: c.CredentialId ?? '',
      name: c.FriendlyCredentialName ?? '',
      createdAt: c.CreatedAt ? new Date(c.CreatedAt).toISOString() : null,
      attachment: c.AuthenticatorAttachment ?? null,
    }));
    return successResponse({ passkeys });
  }
).use(authMiddleware());

// POST /auth/passkeys/register/start
export const passkeyRegisterStart = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    requireEnabled();
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<PasskeyRegisterStartInput>;
    const accessToken = await verifiedCallerAccessToken(event);

    const reauth = await reauthenticate(user, validatedBody.password, validatedBody.code);
    if (reauth.challenged && !reauth.accessToken) {
      throw mfaError(400, 'Enter a code from your authenticator app as well.', 'CODE_REQUIRED');
    }

    const started = await cognito.send(
      new StartWebAuthnRegistrationCommand({ AccessToken: accessToken })
    );
    return successResponse({ options: parseOptions(started.CredentialCreationOptions) });
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(passkeyRegisterStartSchema));

// POST /auth/passkeys/register/finish
export const passkeyRegisterFinish = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    requireEnabled();
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<PasskeyRegisterFinishInput>;
    const accessToken = await verifiedCallerAccessToken(event);

    try {
      await cognito.send(
        new CompleteWebAuthnRegistrationCommand({
          AccessToken: accessToken,
          // Plain JSON by construction (it arrived as a parsed request body).
          Credential:
            validatedBody.credential as CompleteWebAuthnRegistrationCommandInput['Credential'],
        })
      );
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'WebAuthnChallengeNotFoundException') {
        throw mfaError(409, 'That took too long. Add the passkey again.', 'PASSKEY_EXPIRED');
      }
      if (REJECTED.has(name)) {
        throw mfaError(400, 'That passkey could not be added.', 'PASSKEY_REJECTED');
      }
      throw error;
    }

    audit('auth.passkey.added', { actorId: user.userId, actorEmail: user.email });
    return successResponse({ added: true }, 201);
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(passkeyRegisterFinishSchema));

// DELETE /auth/passkeys/{credentialId}
export const deletePasskey = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    requireEnabled();
    const { user } = event as AuthenticatedEvent;
    const credentialId = event.pathParameters?.credentialId;
    if (!credentialId || credentialId.length > 1024) {
      throw createHttpError(400, 'Passkey id is required');
    }
    const accessToken = await verifiedCallerAccessToken(event);

    try {
      await cognito.send(
        new DeleteWebAuthnCredentialCommand({
          AccessToken: accessToken,
          CredentialId: credentialId,
        })
      );
    } catch (error) {
      if ((error as Error).name === 'ResourceNotFoundException') {
        throw createHttpError(404, 'That passkey was not found');
      }
      throw error;
    }

    audit('auth.passkey.removed', { actorId: user.userId, actorEmail: user.email });
    return noContentResponse();
  }
)
  .use(authRateLimit())
  .use(authMiddleware());
