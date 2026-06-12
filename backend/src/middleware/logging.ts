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
      // Method/path live at the top level in REST/HTTP-v1 events and under
      // `requestContext.http` in HTTP API v2 — fall back so logs are populated
      // behind either API type.
      const httpCtx = (event.requestContext as { http?: { method?: string; path?: string } })?.http;
      log.info(
        {
          method: event.httpMethod ?? httpCtx?.method,
          path: event.path ?? (event as { rawPath?: string }).rawPath ?? httpCtx?.path,
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
