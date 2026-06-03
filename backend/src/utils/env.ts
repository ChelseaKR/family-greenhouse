/**
 * Read a required environment variable. Throws synchronously at module load
 * if the variable is missing or empty so misconfigured Lambdas fail fast
 * instead of returning empty strings to callers.
 *
 * In NODE_ENV=test, missing vars resolve to a sentinel placeholder so unit
 * tests that mock the AWS SDK don't need to set every env var.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (process.env.NODE_ENV === 'test') return `__test_${name}__`;
  throw new Error(`Missing required environment variable: ${name}`);
}

/**
 * Read an optional environment variable. Returns `undefined` (not the test
 * sentinel) when missing — used for features that should disable themselves
 * cleanly when not configured, e.g. third-party API keys.
 */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
