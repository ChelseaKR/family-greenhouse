import middy from '@middy/core';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ZodSchema, ZodError } from 'zod';
import createHttpError from 'http-errors';

export interface ValidatedEvent<T> extends APIGatewayProxyEvent {
  validatedBody: T;
}

export const validateBody = <T>(
  schema: ZodSchema<T>
): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> => {
  const before: middy.MiddlewareFn<APIGatewayProxyEvent, APIGatewayProxyResult> = (request) => {
    const event = request.event;

    // Parse separately from validation: a malformed body is a client error
    // (400), not an internal one. Without this, the bare JSON.parse throws a
    // SyntaxError that the error handler masks as a 500.
    let body: unknown;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw createHttpError(400, 'Invalid JSON body');
      }
      throw error;
    }

    try {
      const validated = schema.parse(body);
      (event as ValidatedEvent<T>).validatedBody = validated;
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.reduce(
          (acc, err) => {
            const path = err.path.join('.');
            if (!acc[path]) {
              acc[path] = [];
            }
            acc[path].push(err.message);
            return acc;
          },
          {} as Record<string, string[]>
        );

        throw createHttpError(400, 'Validation failed', { details });
      }
      throw error;
    }
  };

  return {
    before,
  };
};

// Note: validatePathParams + validateQueryParams previously existed here but
// were never imported by any production handler. Deleted 2026-06-01 per code
// review. If a future caller wants path-param validation, prefer a single
// `requirePathParam(event, name)` helper that just throws 400 when missing —
// the Zod-based version was overkill since API Gateway already populates
// pathParameters for any route it matched.
