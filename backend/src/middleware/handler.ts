/**
 * The base middy stack every Lambda handler is wrapped with. Order matters:
 *
 *   0. securityHeaders     — stamp HSTS/CSP/nosniff on the final response (first
 *                            so its after/onError run last; see securityHeaders.ts)
 *   1. bodySizeGuard       — reject oversized bodies before parsing
 *   2. httpJsonBodyParser  — parse application/json (no-op for other types)
 *   3. httpCors            — add CORS headers; refuses to start in prod without ALLOWED_ORIGIN
 *   4. loggingMiddleware   — pino child logger keyed to request-id + user-id
 *   5. httpErrorHandler    — convert thrown HttpError → JSON response
 *
 * Resource-specific middleware (auth, validation) layer on top via `.use()`.
 */
import middy from '@middy/core';
import httpCors from '@middy/http-cors';
import httpErrorHandler from '@middy/http-error-handler';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import { Handler } from 'aws-lambda';
import { bodySizeGuard } from './bodySize.js';
import { loggingMiddleware } from './logging.js';
import { securityHeaders } from './securityHeaders.js';

function resolveCorsOrigin(): string {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && allowed.length > 0) return allowed;
  // Wildcard with credentials:true is rejected by browsers and unsafe; only
  // permit a wildcard in local development where ALLOWED_ORIGIN is unset.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ALLOWED_ORIGIN must be set in production');
  }
  return 'http://localhost:3000';
}

export function createHandler<TEvent, TResult>(handler: Handler<TEvent, TResult>) {
  return (
    middy(handler)
      // First in the chain so its after/onError run last and stamp the final
      // response (see securityHeaders.ts).
      .use(securityHeaders())
      .use(bodySizeGuard())
      .use(httpJsonBodyParser({ disableContentTypeError: true }))
      .use(
        httpCors({
          origin: resolveCorsOrigin(),
          credentials: true,
        })
      )
      .use(loggingMiddleware())
      .use(httpErrorHandler())
  );
}

/**
 * Variant of `createHandler` that DOES NOT register the JSON body parser.
 * Use this for Stripe webhook receivers and anywhere else the raw bytes of
 * `event.body` must reach the handler intact for signature verification.
 *
 * Re-serializing JSON after the body parser ran does not produce the same
 * bytes Stripe HMAC'd over (key ordering, whitespace, escape conventions
 * all differ) — every webhook would fail signature verification.
 */
export function createRawBodyHandler<TEvent, TResult>(handler: Handler<TEvent, TResult>) {
  return middy(handler)
    .use(securityHeaders())
    .use(bodySizeGuard())
    .use(
      httpCors({
        origin: resolveCorsOrigin(),
        credentials: true,
      })
    )
    .use(loggingMiddleware())
    .use(httpErrorHandler());
}
