/**
 * Reads the `exp` claim off a JWT without verifying it. The backend is the
 * only judge of a token; this is a hint that lets the client skip a request
 * it already knows will be refused.
 *
 * A cold start of the app more than an hour after the last one carries an
 * expired ID token. Sending it to `/auth/me` first costs a round trip whose
 * answer is known (401), and only then the refresh and the retry. Knowing
 * the expiry up front, the client goes straight to the refresh. A token
 * that cannot be read is treated as not expired, so the server still gets
 * the last word.
 */

/** How early a token is treated as expired, so a request never lands a second too late. */
export const EXPIRY_SKEW_SECONDS = 30;

export function jwtExpiresAt(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True only when the token carries a readable `exp` that has passed (less the skew). */
export function jwtIsExpired(token: string, now: number = Date.now()): boolean {
  const expiresAt = jwtExpiresAt(token);
  return expiresAt !== null && expiresAt - EXPIRY_SKEW_SECONDS * 1000 <= now;
}
