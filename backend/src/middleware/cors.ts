/**
 * Shared exact-origin CORS policy.
 *
 * ALLOWED_ORIGIN is ordered: the public web origin first (also used for link
 * building), followed by the Capacitor shell origins. Custom WebView schemes
 * such as capacitor:// are valid browser origins but are rejected by AWS's
 * managed API Gateway / Function URL CORS APIs, so the application layer is
 * the eventual source of truth for the complete list.
 */

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Household-Id',
  'X-Cognito-Access-Token',
] as const;

export const CORS_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const CORS_MAX_AGE_SECONDS = 300;

interface CorsResponsePolicy {
  allowedHeaders?: readonly string[];
  allowedMethods?: readonly string[];
  maxAgeSeconds?: number;
}

export function resolveCorsOrigins(): string[] {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && allowed.length > 0) {
    const origins = allowed
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    if (origins.length === 0) {
      throw new Error('ALLOWED_ORIGIN must contain at least one exact origin');
    }
    if (origins.some((origin) => origin.includes('*'))) {
      throw new Error('ALLOWED_ORIGIN wildcards are not permitted');
    }
    return origins;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ALLOWED_ORIGIN must be set in production');
  }
  return ['http://localhost:3000'];
}

/** The user-facing web origin (the first allowlist entry), for link building. */
export function firstAllowedOrigin(): string | undefined {
  return resolveCorsOrigins()[0];
}

function requestOrigin(headers?: Record<string, string | undefined>): string | undefined {
  return headers?.origin ?? headers?.Origin;
}

/**
 * Headers for responses that cannot use Middy's normal CORS middleware (the
 * outer router's 404 and the streaming Function URL). Unknown origins never
 * receive Access-Control-Allow-Origin; exact matching is deliberate.
 */
export function corsHeadersForRequest(
  headers?: Record<string, string | undefined>,
  policy: CorsResponsePolicy = {}
): Record<string, string> {
  const origin = requestOrigin(headers);
  const responseHeaders: Record<string, string> = { Vary: 'Origin' };
  if (!origin || !resolveCorsOrigins().includes(origin)) return responseHeaders;

  const allowedHeaders = policy.allowedHeaders ?? CORS_ALLOWED_HEADERS;
  const allowedMethods = policy.allowedMethods ?? CORS_ALLOWED_METHODS;
  const maxAgeSeconds = policy.maxAgeSeconds ?? CORS_MAX_AGE_SECONDS;

  return {
    ...responseHeaders,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': allowedHeaders.join(', '),
    'Access-Control-Allow-Methods': allowedMethods.join(', '),
    'Access-Control-Max-Age': String(maxAgeSeconds),
  };
}
