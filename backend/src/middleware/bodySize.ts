import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB — bigger than any JSON payload this app sends.

/**
 * Reject incoming requests whose body exceeds `maxBytes`. API Gateway already
 * caps at 10 MB, but the JSON parser will happily marshal 9.9 MB of garbage
 * into a Lambda's memory before validation runs; this is a cheaper guardrail.
 */
export function bodySizeGuard(
  maxBytes = DEFAULT_MAX_BYTES
): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const body = request.event.body;
    if (typeof body !== 'string') return;
    const length = request.event.isBase64Encoded
      ? Math.floor((body.length * 3) / 4)
      : Buffer.byteLength(body, 'utf8');
    if (length > maxBytes) {
      throw createHttpError(413, 'Payload too large');
    }
  };
  return { before };
}
