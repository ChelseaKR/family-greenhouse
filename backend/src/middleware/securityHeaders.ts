/**
 * Stamp security response headers on every API response — success and error
 * alike. This is defense-in-depth alongside the CloudFront response-headers
 * policy on the static frontend (`infrastructure/modules/frontend`); here we
 * cover the API surface directly so the headers are present even if the API
 * is hit without going through a CDN.
 *
 * Register this FIRST in the middy stack (see `createHandler`): middy runs
 * `after` hooks in reverse registration order, so the first-registered hook
 * runs last and stamps the *final* response; likewise its `onError` runs after
 * `httpErrorHandler` has produced the error response.
 *
 * The API only ever returns data (JSON, iCal, a redirect) — never HTML or
 * scripts — so the CSP is locked all the way down.
 */
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export function securityHeaders(): middy.MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult
> {
  const apply: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const response = request.response;
    if (!response || typeof response !== 'object') return;
    // Our headers win over anything the handler set for these keys.
    response.headers = { ...(response.headers ?? {}), ...SECURITY_HEADERS };
  };

  return { after: apply, onError: apply };
}

export const _securityHeaders = SECURITY_HEADERS;
