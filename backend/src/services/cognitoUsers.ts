import {
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito, USER_POOL_ID } from '../utils/cognito.js';

/**
 * Write the household membership claims onto the Cognito user. The next access
 * token Cognito mints will carry these as `custom:household_id` and
 * `custom:household_role` claims, which `authMiddleware` reads.
 *
 * The user does NOT see the new claims until they refresh their token (or log
 * in again), so callers should assume there's a propagation lag of one token.
 */
export async function setHouseholdClaims(
  userId: string,
  householdId: string,
  role: 'admin' | 'member'
): Promise<void> {
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
      UserAttributes: [
        { Name: 'custom:household_id', Value: householdId },
        { Name: 'custom:household_role', Value: role },
      ],
    })
  );
}

export async function clearHouseholdClaims(userId: string): Promise<void> {
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
      UserAttributes: [
        { Name: 'custom:household_id', Value: '' },
        { Name: 'custom:household_role', Value: '' },
      ],
    })
  );
}

export async function deleteUser(userId: string): Promise<void> {
  await cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    })
  );
}

/**
 * Look up a Cognito user's display name (the `name` attribute). Returns the
 * email-localpart fallback if the user has no name attribute set, which can
 * happen for accounts created before the name attribute was required.
 */
export async function getUserName(userId: string, fallbackEmail: string): Promise<string> {
  try {
    const result = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      })
    );
    const nameAttr = result.UserAttributes?.find((a) => a.Name === 'name');
    if (nameAttr?.Value) return nameAttr.Value;
  } catch {
    // fall through to fallback
  }
  return fallbackEmail.split('@')[0];
}
