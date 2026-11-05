/**
 * Is this HTTP status the auth server saying "no" to the session?
 *
 * Only a client-side refusal ends a session: 400 (malformed or unknown
 * refresh token), 401 (expired or invalid token) and 403 (forbidden). A 5xx,
 * a 429 or any other answer means the server could not judge the session
 * right now. Treating those as a refusal signed people out, keychain copy
 * included, for the length of an outage. The session stays; the next
 * answered 401 still ends it.
 */
export function isAuthRejectionStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}
