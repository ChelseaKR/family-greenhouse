import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  GetUserCommand,
  ResendConfirmationCodeCommand,
  ChangePasswordCommand,
  UpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { updateMemberNameAcrossHouseholds } from '../../services/householdService.js';
import { authMiddleware, AuthenticatedEvent } from '../../middleware/auth.js';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import {
  signupSchema,
  loginSchema,
  confirmEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  refreshTokenSchema,
  resendCodeSchema,
  SignupInput,
  LoginInput,
  ConfirmEmailInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  RefreshTokenInput,
  ResendCodeInput,
} from '../../models/schemas.js';
import { cognito, CLIENT_ID } from '../../utils/cognito.js';
import { getUserName } from '../../services/cognitoUsers.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { publicRegistrationIsAvailable } from '../../config/commercialStatus.js';
import type { LoggedEvent } from '../../middleware/logging.js';

// POST /auth/signup
export const signup = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<SignupInput>;

    if (!publicRegistrationIsAvailable()) {
      throw createHttpError(503, 'New account registration is currently paused.', {
        expose: true,
      });
    }

    try {
      await cognito.send(
        new SignUpCommand({
          ClientId: CLIENT_ID,
          Username: validatedBody.email,
          Password: validatedBody.password,
          UserAttributes: [
            { Name: 'email', Value: validatedBody.email },
            { Name: 'name', Value: validatedBody.name },
          ],
        })
      );

      audit('auth.signup', { actorEmail: validatedBody.email });

      return createdResponse({
        message: 'User created. Please check your email for confirmation code.',
      });
    } catch (error) {
      if ((error as Error).name === 'UsernameExistsException') {
        throw createHttpError(400, 'An account with this email already exists');
      }
      if ((error as Error).name === 'InvalidPasswordException') {
        throw createHttpError(400, 'Password does not meet requirements');
      }
      throw error;
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(signupSchema));

// POST /auth/resend-code
export const resendCode = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<ResendCodeInput>;

    try {
      await cognito.send(
        new ResendConfirmationCodeCommand({
          ClientId: CLIENT_ID,
          Username: validatedBody.email,
        })
      );
      return successResponse({ message: 'Confirmation code resent. Check your email.' });
    } catch (error) {
      // Cognito's NotAuthorizedException fires when the user is already confirmed.
      // Treat as 400 with a helpful message rather than leaking the SDK error.
      if ((error as Error).name === 'InvalidParameterException') {
        throw createHttpError(400, 'User is already confirmed');
      }
      if ((error as Error).name === 'UserNotFoundException') {
        // Don't leak account existence — return 200 anyway.
        return successResponse({ message: 'If the account exists, a code was sent.' });
      }
      if ((error as Error).name === 'LimitExceededException') {
        throw createHttpError(429, 'Too many requests. Please wait before trying again.');
      }
      throw error;
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(resendCodeSchema));

// POST /auth/confirm
export const confirmEmail = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<ConfirmEmailInput>;

    try {
      await cognito.send(
        new ConfirmSignUpCommand({
          ClientId: CLIENT_ID,
          Username: validatedBody.email,
          ConfirmationCode: validatedBody.code,
        })
      );

      // Confirmation is the trustworthy signup conversion point. The browser
      // is not authenticated yet (Cognito confirmation returns no JWT), so it
      // cannot use /telemetry/product. Record the event here without the email
      // or any other user-supplied value; Cognito remains the user-count source
      // of truth and this log supplies the funnel timestamp.
      (event as LoggedEvent).log.info(
        {
          msg: 'product_event',
          productEvent: 'signup_completed',
          source: 'auth_confirmation',
        },
        'product_event'
      );

      return successResponse({
        message: 'Email confirmed successfully. Please login.',
      });
    } catch (error) {
      if ((error as Error).name === 'CodeMismatchException') {
        throw createHttpError(400, 'Invalid confirmation code');
      }
      if ((error as Error).name === 'ExpiredCodeException') {
        throw createHttpError(400, 'Confirmation code has expired');
      }
      throw error;
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(confirmEmailSchema));

// POST /auth/login
export const login = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<LoginInput>;

    try {
      const result = await cognito.send(
        new InitiateAuthCommand({
          ClientId: CLIENT_ID,
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: {
            USERNAME: validatedBody.email,
            PASSWORD: validatedBody.password,
          },
        })
      );

      if (!result.AuthenticationResult) {
        throw createHttpError(500, 'Authentication failed');
      }

      // Get user details
      const userResult = await cognito.send(
        new GetUserCommand({
          AccessToken: result.AuthenticationResult.AccessToken,
        })
      );

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
      });

      // Two tokens. The ID token rides the Authorization header for all
      // API calls — it's the only one that carries `custom:household_id`,
      // which the requireHousehold middleware reads. The access token is
      // for Cognito-direct calls (ChangePassword, UpdateUserAttributes)
      // which reject ID tokens.
      return successResponse({
        user,
        idToken: result.AuthenticationResult.IdToken,
        accessToken: result.AuthenticationResult.AccessToken,
        refreshToken: result.AuthenticationResult.RefreshToken,
        expiresIn: result.AuthenticationResult.ExpiresIn,
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'NotAuthorizedException') {
        audit('auth.login.failure', { actorEmail: validatedBody.email });
        throw createHttpError(401, 'Invalid email or password');
      }
      if (name === 'UserNotConfirmedException') {
        audit('auth.login.failure', {
          actorEmail: validatedBody.email,
          metadata: { reason: 'unconfirmed' },
        });
        throw createHttpError(401, 'Please confirm your email first');
      }
      throw error;
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(loginSchema));

// POST /auth/refresh
export const refreshToken = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<RefreshTokenInput>;

    try {
      const result = await cognito.send(
        new InitiateAuthCommand({
          ClientId: CLIENT_ID,
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: {
            REFRESH_TOKEN: validatedBody.refreshToken,
          },
        })
      );

      if (!result.AuthenticationResult) {
        throw createHttpError(500, 'Token refresh failed');
      }

      // Cognito's REFRESH_TOKEN_AUTH flow does NOT issue a new refresh
      // token — the original keeps its 30-day TTL. Echo it back so the
      // frontend's setTokens() always sees a defined value (otherwise it
      // clobbers stored state and the next 401 logs the user out).
      return successResponse({
        idToken: result.AuthenticationResult.IdToken,
        accessToken: result.AuthenticationResult.AccessToken,
        refreshToken: validatedBody.refreshToken,
        expiresIn: result.AuthenticationResult.ExpiresIn,
      });
    } catch (error) {
      if ((error as Error).name === 'NotAuthorizedException') {
        throw createHttpError(401, 'Invalid or expired refresh token');
      }
      throw error;
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(refreshTokenSchema));

// POST /auth/forgot-password
export const forgotPassword = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<ForgotPasswordInput>;

    // Audit BEFORE the Cognito call so the request itself is logged whether
    // or not the user exists. Don't include the result branch in the log.
    audit('auth.password_reset_requested', { actorEmail: validatedBody.email });
    try {
      await cognito.send(
        new ForgotPasswordCommand({
          ClientId: CLIENT_ID,
          Username: validatedBody.email,
        })
      );

      return successResponse({
        message: 'If an account exists, a reset code has been sent.',
      });
    } catch {
      // Don't reveal if user exists
      return successResponse({
        message: 'If an account exists, a reset code has been sent.',
      });
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(forgotPasswordSchema));

// POST /auth/reset-password
export const resetPassword = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<ResetPasswordInput>;

    try {
      await cognito.send(
        new ConfirmForgotPasswordCommand({
          ClientId: CLIENT_ID,
          Username: validatedBody.email,
          ConfirmationCode: validatedBody.code,
          Password: validatedBody.newPassword,
        })
      );

      return successResponse({
        message: 'Password reset successfully. Please login with your new password.',
      });
    } catch (error) {
      if ((error as Error).name === 'CodeMismatchException') {
        throw createHttpError(400, 'Invalid reset code');
      }
      if ((error as Error).name === 'ExpiredCodeException') {
        throw createHttpError(400, 'Reset code has expired');
      }
      if ((error as Error).name === 'InvalidPasswordException') {
        throw createHttpError(400, 'Password does not meet requirements');
      }
      throw error;
    }
  }
)
  .use(authRateLimit())
  .use(validateBody(resetPasswordSchema));

// POST /auth/change-password
//
// Authenticated password change for users who already know their current
// password. (Forgot-password flow handles the lost-password case.) Cognito
// requires the raw access token, which we lift from the Authorization header
// directly — the JWT-validated `event.user` doesn't carry it.
const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// PATCH /auth/me — update editable profile attributes. Today only `name`;
// email changes go through the email-verification flow, which we haven't
// built yet, so adding email here would be a footgun.
const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updateProfile = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<UpdateProfileInput>;
    const ev = event as AuthenticatedEvent;
    // Read the Cognito access token from a dedicated header so the
    // Authorization header stays the ID token (which API Gateway's JWT
    // authorizer validates + which authMiddleware reads custom claims from).
    // Cognito ChangePassword + UpdateUserAttributes reject ID tokens.
    const accessToken =
      event.headers?.['x-cognito-access-token'] ?? event.headers?.['X-Cognito-Access-Token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw createHttpError(401, 'Missing Cognito access token');
    }

    // Verify the access token actually belongs to the authenticated caller
    // before mutating attributes with it. Without this check, a caller could
    // present THEIR ID token (passing authMiddleware) alongside someone
    // else's access token and rewrite that other user's profile — and our
    // DDB fan-out below would then run under the wrong identity.
    let tokenSub: string | null;
    try {
      const tokenUser = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
      tokenSub =
        tokenUser.UserAttributes?.find((a) => a.Name === 'sub')?.Value ??
        tokenUser.Username ??
        null;
    } catch {
      throw createHttpError(401, 'Invalid Cognito access token');
    }
    if (!tokenSub || tokenSub !== ev.user?.userId) {
      throw createHttpError(403, 'Access token does not match the authenticated user');
    }

    await cognito.send(
      new UpdateUserAttributesCommand({
        AccessToken: accessToken,
        UserAttributes: [{ Name: 'name', Value: validatedBody.name }],
      })
    );
    if (ev.user?.userId) {
      // Best-effort fan-out: if the DDB update fails partway, Cognito and
      // member rows can drift, but the user can re-submit and converge.
      // We surface a 500 so they know to retry rather than silently leaving
      // member listings stale.
      await updateMemberNameAcrossHouseholds(ev.user.userId, validatedBody.name);
    }

    audit('auth.profile_updated', {
      actorId: ev.user?.userId,
      actorEmail: ev.user?.email,
    });

    return successResponse({
      id: ev.user?.userId ?? '',
      email: ev.user?.email ?? '',
      name: validatedBody.name,
    });
  }
)
  // Same throttle as the other auth-mutation endpoints (changePassword etc.)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(updateProfileSchema));

export const changePassword = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<ChangePasswordInput>;
    // Read the Cognito access token from a dedicated header so the
    // Authorization header stays the ID token (which API Gateway's JWT
    // authorizer validates + which authMiddleware reads custom claims from).
    // Cognito ChangePassword + UpdateUserAttributes reject ID tokens.
    const accessToken =
      event.headers?.['x-cognito-access-token'] ?? event.headers?.['X-Cognito-Access-Token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw createHttpError(401, 'Missing Cognito access token');
    }
    try {
      await cognito.send(
        new ChangePasswordCommand({
          AccessToken: accessToken,
          PreviousPassword: validatedBody.oldPassword,
          ProposedPassword: validatedBody.newPassword,
        })
      );
      const ev = event as AuthenticatedEvent;
      // 'auth.password_changed', not 'auth.password_reset_completed' — this
      // is the knows-current-password flow; reset events belong to the
      // forgot-password flow and the two must stay distinguishable in audit.
      audit('auth.password_changed', {
        actorId: ev.user?.userId,
        actorEmail: ev.user?.email,
      });
      return successResponse({ message: 'Password updated.' });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'NotAuthorizedException') {
        throw createHttpError(401, 'Current password is incorrect');
      }
      if (name === 'InvalidPasswordException') {
        throw createHttpError(400, 'New password does not meet requirements');
      }
      throw err;
    }
  }
)
  .use(authRateLimit())
  .use(authMiddleware())
  .use(validateBody(changePasswordSchema));

// GET /auth/me
//
// Current user, used by the frontend to verify a stored token on boot and
// rehydrate the auth store. Returns the claim-derived identity plus the
// display name pulled from Cognito.
export const getMe = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const name = await getUserName(user.userId, user.email);
    return successResponse({
      id: user.userId,
      email: user.email,
      name,
      householdId: user.householdId,
      householdRole: user.householdRole,
    });
  }
).use(authMiddleware());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'POST /auth/signup': signup,
  'POST /auth/resend-code': resendCode,
  'POST /auth/confirm': confirmEmail,
  'POST /auth/login': login,
  'POST /auth/refresh': refreshToken,
  'POST /auth/forgot-password': forgotPassword,
  'POST /auth/reset-password': resetPassword,
  'POST /auth/change-password': changePassword,
  'GET /auth/me': getMe,
  'PATCH /auth/me': updateProfile,
});
