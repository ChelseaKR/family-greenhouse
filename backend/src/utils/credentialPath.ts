/**
 * Request paths that carry a credential (#450).
 *
 * A capability URL puts its only credential in the path — `/sitter/{token}`,
 * `/kiosk/{token}`, `/tag/{token}`, `/caretaker/{token}`,
 * `/calendar/{token}/…` and `/plants/shared/{code}` — so any line that echoes
 * the request path turns its retention into a plaintext token store, which is
 * exactly what hashing them at rest set out to avoid. API Gateway has already
 * bound the secret segment to a named path parameter; this substitutes the
 * template placeholder for the value.
 *
 * The parameter NAMES that are credentials are listed here once. A route that
 * carries a credential under some other name must be added here, and
 * `tests/integration/credential-leaks.test.ts` drives a request down every
 * such route and fails if the credential appears in a log line.
 */
export const CREDENTIAL_PATH_PARAMS = ['token', 'code'] as const;

/** Nothing shorter is a credential (they are 128 to 256 bits, hex); the floor
 *  only stops a one-character value from rewriting half of an unrelated path. */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * `path` with every credential path parameter's value replaced by its
 * `{name}` placeholder, in both its raw and its percent-encoded spelling.
 * Every other segment is returned unchanged.
 */
export function redactCredentialPath(
  path: string,
  pathParameters: Record<string, string | undefined> | null | undefined
): string {
  let redacted = path;
  for (const name of CREDENTIAL_PATH_PARAMS) {
    const value = pathParameters?.[name];
    if (!value || value.length < MIN_CREDENTIAL_LENGTH) continue;
    for (const spelling of new Set([value, encodeURIComponent(value)])) {
      redacted = redacted.split(spelling).join(`{${name}}`);
    }
  }
  return redacted;
}
