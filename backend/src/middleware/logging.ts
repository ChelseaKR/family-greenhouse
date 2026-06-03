import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger, Logger, withRequest, currentTraceId } from '../utils/logger.js';
import { AuthenticatedEvent } from './auth.js';

export interface LoggedEvent extends APIGatewayProxyEvent {
  log: Logger;
}

/**
 * Attach a request-scoped logger and log a one-line "request" + "response"
 * record per invocation. Should sit late in the chain (after auth) so the
 * logger picks up user-id and household-id when present.
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
      const auth = (event as AuthenticatedEvent).user;
      const log = withRequest({
        requestId,
        userId: auth?.userId,
        householdId: auth?.householdId ?? undefined,
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
          msg: 'response',
        },
        'response'
      );
    },
    onError: (request) => {
      const log = (request.event as LoggedEvent).log ?? logger;
      log.error({ err: request.error, msg: 'handler_error' }, 'handler_error');
    },
  };
}
