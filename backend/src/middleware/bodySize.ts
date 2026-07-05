import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB — bigger than any JSON payload this app sends.

/**
 * Override for the two image-upload-as-base64 routes (species identify,
 * leaf-health-check). Their own Zod schemas already cap the `image`/
 * `imageBase64` field at 350,000 characters — the base64-text equivalent of
 * a 256 KiB RAW/BINARY image (256*1024*4/3 ≈ 349,525) — but this middleware
 * runs first and measures the whole JSON-wrapped BODY, which is a few bytes
 * larger than the field alone. With the old global default (also 256 KiB)
 * this guard rejected any upload the schema would have accepted above
 * roughly 262,000 of those 350,000 permitted characters — about the top
 * quarter of "downscaled, in-spec" photos — with a generic "Payload too
 * large" 413 that never even reached the schema's clearer error message.
 * A close-up, detail-rich leaf photo lands in that gap often enough that
 * real iPhone uploads were hitting it. Comfortably above the schema's own
 * ceiling plus JSON envelope overhead.
 */
export const IMAGE_BODY_MAX_BYTES = 400 * 1024;

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
