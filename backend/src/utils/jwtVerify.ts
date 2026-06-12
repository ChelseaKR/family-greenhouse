/**
 * In-handler Cognito JWT verification for entry points that are NOT behind
 * the API Gateway JWT authorizer — today that's the chat streaming Lambda
 * Function URL (handlers/chat/streamHandler.ts). Function URLs have no
 * authorizer, so `requestContext.authorizer.*` is attacker-controlled absent
 * this check: the handler MUST verify the token signature itself before
 * trusting any claim.
 *
 * Uses aws-jwt-verify, which validates signature (against the pool's JWKS,
 * fetched once and cached in-process), issuer, audience (client id), expiry,
 * and token_use. The verifier is cached at module scope so warm invocations
 * skip the JWKS fetch entirely.
 *
 * Verifies ID tokens specifically — the frontend sends the Cognito ID token
 * in `Authorization`, which is also what the API Gateway authorizer accepts
 * (its `audience` is the client id; access tokens carry `client_id` instead
 * of `aud` and would fail there too). Keeping tokenUse: 'id' makes the
 * Function URL accept exactly the tokens the rest of the API accepts.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';

type IdTokenVerifier = ReturnType<
  typeof CognitoJwtVerifier.create<{
    userPoolId: string;
    tokenUse: 'id';
    clientId: string;
  }>
>;

let cachedVerifier: IdTokenVerifier | null = null;

function getVerifier(): IdTokenVerifier {
  if (!cachedVerifier) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (!userPoolId || !clientId) {
      // Fail closed: without pool configuration nothing can be verified.
      throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set');
    }
    cachedVerifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId });
  }
  return cachedVerifier;
}

/**
 * Verify a raw Cognito ID-token JWT. Returns the verified payload, or throws
 * (aws-jwt-verify error) on ANY failure — bad signature, wrong pool/client,
 * expired, wrong token_use, malformed. Callers translate the throw to 401.
 */
export async function verifyCognitoIdToken(token: string): Promise<CognitoIdTokenPayload> {
  return getVerifier().verify(token);
}

/** Test hook: drop the cached verifier so env/mocks can be swapped. */
export function __resetJwtVerifierForTests(): void {
  cachedVerifier = null;
}
