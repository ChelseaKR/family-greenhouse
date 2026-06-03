import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { requireEnv } from './env.js';

export const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

export const USER_POOL_ID = requireEnv('COGNITO_USER_POOL_ID');
export const CLIENT_ID = requireEnv('COGNITO_CLIENT_ID');
