import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import * as plantIdentification from '../../services/plantIdentification.js';
import { successResponse } from '../../utils/response.js';

// We accept a data URL or a bare base64 string. The Plant.id SDK accepts both.
// Cap the body size at the middleware level (256 KiB) — clients should resize
// to <200 KiB before posting.
const identifySchema = z.object({
  image: z.string().min(64).max(350_000, 'Image too large; resize to under 256 KB'),
});

type IdentifyInput = z.infer<typeof identifySchema>;

function stripDataUrlPrefix(s: string): string {
  const m = /^data:image\/[a-z]+;base64,(.+)$/i.exec(s);
  return m ? m[1] : s;
}

// POST /plants/identify
export const identify = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<IdentifyInput>;
    const base64 = stripDataUrlPrefix(validatedBody.image);
    try {
      const result = await plantIdentification.identifyPlant(base64);
      return successResponse(result);
    } catch (err) {
      throw createHttpError(502, `Plant identification failed: ${(err as Error).message}`);
    }
  }
)
  .use(authMiddleware())
  .use(validateBody(identifySchema));
