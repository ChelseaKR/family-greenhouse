import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger, Logger, withRequest, currentTraceId } from '../utils/logger.js';
import { AuthenticatedEvent } from './auth.js';

export interface LoggedEvent extends APIGatewayProxyEvent {
  log: Logger;
}

/**
 * Read user identity off the event lazily. `loggingMiddleware`'s `before`
 * hook runs ahead of `authMiddleware` in the middy chain (it's registered
 * in `createHandler`, auth is layered on per-resource afterwards), so
 * `event.user` only exists by the time the `after`/`onError` hooks fire.
 * Binding it into the child logger at `before` time would freeze userId and
 * householdId as undefined for the whole request.
 */
function identityOf(event: APIGatewayProxyEvent): { userId?: string; householdId?: string } {
  const auth = (event as AuthenticatedEvent).user;
  return { userId: auth?.userId, householdId: auth?.householdId ?? undefined };
}

/**
 * The request path as it may be logged. Capability-URL routes
 * (`/sitter/{token}`, `/calendar/{token}/…`) carry their ONLY credential in
 * the path, and a request log that echoed it would turn CloudWatch retention
 * into a plaintext token store — defeating the point of hashing them at
 * rest. API Gateway has already bound the secret segment to the `token`
 * path parameter, so substitute the template placeholder for its value.
 * Every other route logs its concrete path unchanged.
 */
function loggablePath(event: APIGatewayProxyEvent): string | undefined {
  // Method/path live at the top level in REST/HTTP-v1 events and under
  // `requestContext.http` in HTTP API v2 — fall back so logs are populated
  // behind either API type.
  const httpCtx = (event.requestContext as { http?: { path?: string } } | undefined)?.http;
  const raw = event.path ?? (event as { rawPath?: string }).rawPath ?? httpCtx?.path;
  const token = event.pathParameters?.token;
  if (raw && token) return raw.split(token).join('{token}');
  return raw;
}

/**
 * Attach a request-scoped logger and log a one-line "request" + "response"
 * record per invocation. The request-scoped logger carries requestId and
 * traceId; user-id and household-id are resolved lazily in the response
 * hooks because auth hasn't run yet when `before` fires.
 */
export function loggingMiddleware(): middy.MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> {
  return {
    before: (request) => {
      const event = request.event;
      const requestId =
        event.requestContext?.requestId ??
        (typeof event.headers?.['x-request-id'] === 'string'
          ? event.headers['x-request-id']
          : undefined);
      const log = withRequest({
        requestId,
        traceId: currentTraceId(),
      });
      (event as LoggedEvent).log = log;
      const httpCtx = (event.requestContext as { http?: { method?: string } })?.http;
      log.info(
        {
          method: event.httpMethod ?? httpCtx?.method,
          path: loggablePath(event),
          msg: 'request',
        },
        'request'
      );
    },
    after: (request) => {
      const log = (request.event as LoggedEvent).log ?? logger;
      log.info(
        {
          status: request.response?.statusCode,
          ...identityOf(request.event),
          msg: 'response',
        },
        'response'
      );
    },
    onError: (request) => {
      const log = (request.event as LoggedEvent).log ?? logger;
      log.error(
        { err: request.error, ...identityOf(request.event), msg: 'handler_error' },
        'handler_error'
      );
    },
  };
}
