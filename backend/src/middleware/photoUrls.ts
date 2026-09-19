/**
 * Sign every plant photo a response carries, on its way out (ADR 0033).
 *
 * Registered by `createHandler` for every route, so a new surface that returns
 * a plant, a photo, an activity entry or a visit record gets signed URLs
 * without having to remember to ask for them. The rules — which fields, which
 * households, how long — live in `services/photoAccess.ts`.
 *
 * Only a successful JSON body is touched. The cheap substring test keeps the
 * parse off every response that cannot hold a photo reference.
 */
import middy from '@middy/core';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { photoUrlScopeFor, signPhotoUrlsIn } from '../services/photoAccess.js';

/** Every stored reference has this in its path; a body without it has none. */
const REFERENCE_MARKER = '/plants/';

function isJsonResponse(response: APIGatewayProxyResult): boolean {
  const headers = response.headers ?? {};
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-type'
  )?.[1];
  return typeof contentType === 'string' && contentType.toLowerCase().includes('application/json');
}

export function photoUrlSigner(): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  const after: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = async (
    request
  ) => {
    const response = request.response;
    if (!response || typeof response !== 'object') return;
    if (response.isBase64Encoded || typeof response.body !== 'string') return;
    if (!response.body.includes(REFERENCE_MARKER) || !isJsonResponse(response)) return;

    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      return;
    }
    const { signed, unsigned } = await signPhotoUrlsIn(body, photoUrlScopeFor(request.event));
    if (signed > 0 || unsigned > 0) response.body = JSON.stringify(body);
  };

  return { after };
}
