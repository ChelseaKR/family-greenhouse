/**
 * Per-group Lambda dispatcher.
 *
 * Each handler group (`handlers/<group>/handler.ts`) exports one middy handler
 * *per route*. AWS Lambda, though, invokes a single configured entrypoint
 * (`handler.handler`). `createRouter` bridges the two: it builds that single
 * entrypoint and dispatches each invocation to the right per-route handler.
 *
 * It keys on the route, which API Gateway has already matched for us:
 *   - HTTP API (v2, payload format 2.0): `event.routeKey` is e.g. `"GET /plants/{id}"`.
 *   - REST API (v1): we reconstruct the same string from `httpMethod` + `resource`.
 * Either way, API Gateway has already populated `event.pathParameters`, so the
 * per-route handlers need no change.
 *
 * Map keys use the API Gateway `{param}` placeholder form (matching `routeKey`),
 * not the `:param` form used in the handlers' `// METHOD /path` doc comments.
 * The router exposes its `routes` so a test can assert it covers every
 * documented route (see `tests/unit/middleware/router.test.ts`).
 */
import type { APIGatewayProxyResult, Context } from 'aws-lambda';
import { instrument } from '../utils/sentry.js';
import { _securityHeaders } from './securityHeaders.js';

/**
 * The inline 404 below never passes through the per-route middy stack, so it
 * misses the `securityHeaders` and `httpCors` middleware every real response
 * gets. Without CORS headers the browser surfaces an opaque CORS error
 * instead of the 404 body. Mirror `resolveCorsOrigin` in handler.ts (not
 * exported there); unlike the cold-start check there we don't throw on a
 * missing ALLOWED_ORIGIN — a 404 without a CORS header beats failing the
 * whole dispatch.
 */
function notFoundHeaders(): Record<string, string> {
  const origin =
    process.env.ALLOWED_ORIGIN && process.env.ALLOWED_ORIGIN.length > 0
      ? process.env.ALLOWED_ORIGIN
      : 'http://localhost:3000';
  return {
    'Content-Type': 'application/json',
    ..._securityHeaders,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

/**
 * A middy-wrapped per-route handler. The `event: never` parameter is a
 * contravariance trick: a function that accepts a concrete `APIGatewayProxyEvent`
 * is assignable here, so every group's exported handlers slot in without a cast
 * at the call site that builds the map.
 */
export type RouteHandler = (event: never, context: Context) => Promise<APIGatewayProxyResult>;

export interface RouterHandler {
  (event: unknown, context: Context): Promise<APIGatewayProxyResult>;
  /** The route keys this router knows about (e.g. `"GET /plants/{id}"`). */
  routes: string[];
}

function routeKeyFor(event: Record<string, unknown>): string {
  if (typeof event.routeKey === 'string') return event.routeKey;
  // REST API (v1) fallback: method + resource template reproduce the v2 key.
  const method = typeof event.httpMethod === 'string' ? event.httpMethod : 'GET';
  const resource = typeof event.resource === 'string' ? event.resource : '/';
  return `${method} ${resource}`;
}

export function createRouter(routes: Record<string, RouteHandler>): RouterHandler {
  const dispatcher = ((event: unknown, context: Context) => {
    const key = routeKeyFor((event ?? {}) as Record<string, unknown>);
    const route = routes[key];
    if (!route) {
      return Promise.resolve({
        statusCode: 404,
        headers: notFoundHeaders(),
        body: JSON.stringify({ message: `No route handler for ${key}` }),
      });
    }
    return route(event as never, context);
  }) as RouterHandler;
  // Sentry-wrap at the outermost layer so unhandled exceptions from any per-
  // route handler reach Sentry. `instrument` no-ops when SENTRY_DSN is unset
  // (see utils/sentry.ts) so this is free in environments that haven't
  // configured Sentry yet. Routes is attached AFTER wrapping so the drift-
  // guard test can still introspect.
  const wrapped = instrument(
    dispatcher as unknown as (...a: unknown[]) => unknown
  ) as RouterHandler;
  wrapped.routes = Object.keys(routes);
  return wrapped;
}
