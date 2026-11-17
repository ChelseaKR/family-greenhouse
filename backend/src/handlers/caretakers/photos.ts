/**
 * Caretaker seats — "add a photo", the third and last thing a caretaker may
 * do. Dispatched by the `plants` Lambda group because that group owns the S3
 * image pipeline; the token-scoped auth model is identical to `./public.ts`.
 *
 * The two-step contract is the same one members use, and the same code
 * (services/photoIntake.ts, ADR 0046): the upload URL is signed for one
 * holding key, one content type and one exact size, and nothing is attached
 * to a plant until the confirm call has checked the uploaded bytes and stored
 * the server's own copy. The caretaker path adds no new leniency — the
 * holding key is minted for the token's household and the named plant, and
 * anything else is refused, so a caretaker cannot attach an object to another
 * household's plant even with a crafted URL.
 *
 * The photo lands in the plant's normal timeline (so the household sees it
 * where photos already live), attributed to the caretaker by name, and is
 * also folded into the visit record as proof of the visit.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import {
  caretakerPhotoRequestSchema,
  CaretakerPhotoRequestInput,
  caretakerPhotoConfirmSchema,
  CaretakerPhotoConfirmInput,
} from '../../models/caretakerSchemas.js';
import * as plantService from '../../services/plantService.js';
import { recordActivity } from '../../services/activity.js';
import { scopePhotoUrls } from '../../services/photoAccess.js';
import {
  acceptUploadedPhoto,
  discardAcceptedPhoto,
  presignPhotoUpload,
  readUploadRequest,
} from '../../services/photoIntake.js';
import { successResponse } from '../../utils/response.js';
import { requireActiveCaretaker, recordVisitAction } from './shared.js';

/** The plant must exist in the token's household and still be alive. */
async function requireCaretakerPlant(householdId: string, plantId: string | undefined) {
  if (!plantId) {
    throw createHttpError(400, 'Plant ID is required');
  }
  const plant = await plantService.getPlant(householdId, plantId);
  if (!plant) {
    throw createHttpError(404, 'Plant not found');
  }
  return plant;
}

// POST /caretaker/{token}/plants/{plantId}/photo
//
// Presign a PUT. Nothing is attached to the plant until /confirm.
export const getCaretakerPhotoUploadUrl = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<CaretakerPhotoRequestInput>;
    const caretaker = await requireActiveCaretaker(event);
    const plantId = event.pathParameters?.plantId;
    await requireCaretakerPlant(caretaker.householdId, plantId);

    const requested = readUploadRequest(validatedBody);
    if (!requested.ok) throw createHttpError(400, requested.message);

    return successResponse(
      await presignPhotoUpload({
        householdId: caretaker.householdId,
        plantId: plantId!,
        contentType: requested.contentType,
        contentLength: requested.contentLength,
      })
    );
  },
  // `imageUrl` is the reference the confirm call sends back (ADR 0033).
  { signPhotoUrls: false }
)
  // Each presign invites an S3 PUT; anonymous, so cap harder than the member
  // path (20/min per user) does.
  .use(rateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(caretakerPhotoRequestSchema));

// POST /caretaker/{token}/plants/{plantId}/photo/confirm
//
// Check the uploaded object, store the server's own cleaned copy, then append
// that to the plant's timeline attributed to the caretaker, and record it on
// the visit.
export const confirmCaretakerPhoto = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<CaretakerPhotoConfirmInput>;
    const caretaker = await requireActiveCaretaker(event);
    const plantId = event.pathParameters?.plantId;
    const plant = await requireCaretakerPlant(caretaker.householdId, plantId);

    // The same check, strip and server-side copy as the member route.
    const accepted = await acceptUploadedPhoto(
      caretaker.householdId,
      plantId!,
      validatedBody.imageUrl
    );
    if (!accepted.ok) throw createHttpError(accepted.status, accepted.message);
    const imageUrl = accepted.imageUrl;

    const actorId = `caretaker:${caretaker.id}`;
    let photo;
    try {
      photo = await plantService.appendPlantPhoto(
        caretaker.householdId,
        plantId!,
        imageUrl,
        actorId
      );
    } catch (err) {
      await discardAcceptedPhoto(accepted.key);
      throw err;
    }

    const visitRecorded = await recordVisitAction(caretaker, {
      kind: 'photo',
      entry: {
        photoId: photo.id,
        plantId: plantId!,
        plantName: plant.name,
        imageUrl,
        at: photo.uploadedAt,
      },
    });

    await recordActivity({
      type: 'photo.uploaded',
      householdId: caretaker.householdId,
      actorId,
      actorName: caretaker.name,
      payload: { plantId: plantId!, photoId: photo.id },
    });

    // No account on this route, so the seat says which household's photos
    // the response may sign, and the URL dies with the seat (ADR 0033).
    scopePhotoUrls(event, {
      householdIds: [caretaker.householdId],
      notAfter: caretaker.expiresAt,
    });
    return successResponse({ imageUrl, photo, visitRecorded });
  }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(caretakerPhotoConfirmSchema));
