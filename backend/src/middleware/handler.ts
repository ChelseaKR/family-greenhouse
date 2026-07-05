/**
 * The base middy stack every Lambda handler is wrapped with. Order matters:
 *
 *   0. securityHeaders     — stamp HSTS/CSP/nosniff on the final response (first
 *                            so its after/onError run last; see securityHeaders.ts)
 *   1. bodySizeGuard       — reject oversized bodies before parsing
 *   2. httpJsonBodyParser  — parse application/json (no-op for other types)
 *   3. httpCors            — add CORS headers; refuses to start in prod without ALLOWED_ORIGIN
 *   4. loggingMiddleware   — pino child logger keyed to request-id + user-id
 *   5. jsonErrorHandler    — convert thrown errors → JSON {message, details?}
 *
 * Resource-specific middleware (auth, validation) layer on top via `.use()`.
 */
import middy from '@middy/core';
import httpCors from '@middy/http-cors';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import { Handler } from 'aws-lambda';
import { bodySizeGuard } from './bodySize.js';
import { loggingMiddleware } from './logging.js';
import { securityHeaders } from './securityHeaders.js';

/**
 * Error-body contract: EVERY error response is JSON
 *
 *     { "message": string, "details"?: unknown }
 *
 * with `Content-Type: application/json` and the thrown status code.
 *
 *   - 4xx: the thrown message (and `details`, e.g. Zod field errors from
 *     `validateBody`) is always exposed — these are client-actionable.
 *   - 5xx: a generic "Internal Server Error" by default so internals never
 *     leak, UNLESS the error was thrown with `expose: true`
 *     (`createHttpError(502, 'safe message', { expose: true })`), which marks
 *     it as an intentional, safe-to-show upstream failure.
 *
 * This replaces @middy/http-error-handler, whose defaults stripped intentional
 * 5xx bodies entirely and emitted text/plain for everything else.
 */
function jsonErrorHandler(): middy.MiddlewareObj<unknown, unknown> {
  const onError: middy.MiddlewareFn<unknown, unknown> = (request) => {
    // Another onError middleware already produced a response — leave it.
    if (request.response !== undefined && request.response !== null) return;
    // The assertion narrows `request.error` (typed `Error | null | undefined`
    // by middy) to expose the optional http-errors fields we read below;
    // dropping it loses those properties and trips no-unsafe-member-access.
    const err = request.error as
      | (Error & { statusCode?: unknown; expose?: unknown; details?: unknown })
      | null;

    const rawStatus = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    const statusCode = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;

    let message = 'Internal Server Error';
    let details: unknown;
    const exposable = statusCode < 500 || err?.expose === true;
    if (exposable) {
      message = err?.message || message;
      details = err?.details;
    }

    request.response = {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(details === undefined ? { message } : { message, details }),
    };
  };
  return { onError };
}

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

export function createHandler<TEvent, TResult>(
  handler: Handler<TEvent, TResult>,
  opts?: { maxBodyBytes?: number }
) {
  return (
    middy(handler)
      // First in the chain so its after/onError run last and stamp the final
      // response (see securityHeaders.ts).
      .use(securityHeaders())
      .use(bodySizeGuard(opts?.maxBodyBytes))
      .use(httpJsonBodyParser({ disableContentTypeError: true }))
      .use(
        httpCors({
          origin: resolveCorsOrigin(),
          credentials: true,
        })
      )
      .use(loggingMiddleware())
      .use(jsonErrorHandler())
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
    .use(jsonErrorHandler());
}
