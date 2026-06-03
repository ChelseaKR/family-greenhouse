/**
 * Tiny helpers for building API Gateway proxy responses with consistent
 * shape: JSON body, `Content-Type: application/json` for everything except
 * `204 No Content`. Handlers should `return successResponse(...)` rather
 * than constructing the response object inline so output stays uniform.
 */
import { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Default 200; pass a status code to override (e.g. 202 for queued work).
 */
export function successResponse(data: unknown, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

/** 201 Created with a JSON body — for resource-creating POSTs. */
export function createdResponse(data: unknown): APIGatewayProxyResult {
  return successResponse(data, 201);
}

/** 204 No Content with an empty body — for successful DELETEs and similar. */
export function noContentResponse(): APIGatewayProxyResult {
  return {
    statusCode: 204,
    headers: {},
    body: '',
  };
}

/**
 * 200 with a Cache-Control header for endpoints whose response is the same
 * for every authenticated caller (templates, plan catalog, species data).
 * `private` stays the default — even when the body is identical, we don't
 * want shared caches between users without an explicit decision.
 *
 * `maxAgeSeconds` is the freshness window; CloudFront and the browser will
 * both honor it. Don't use this on user-scoped data unless you've thought
 * through the cache-key (e.g. include the auth identifier in the URL).
 */
export function cacheableResponse(
  data: unknown,
  options: { maxAgeSeconds: number; visibility?: 'public' | 'private' } = {
    maxAgeSeconds: 300,
    visibility: 'private',
  }
): APIGatewayProxyResult {
  const visibility = options.visibility ?? 'private';
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `${visibility}, max-age=${options.maxAgeSeconds}`,
    },
    body: JSON.stringify(data),
  };
}
