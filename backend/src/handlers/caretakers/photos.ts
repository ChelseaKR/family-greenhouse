/**
 * Caretaker seats — "add a photo", the third and last thing a caretaker may
 * do. Dispatched by the `plants` Lambda group because that group owns the S3
 * image pipeline; the token-scoped auth model is identical to `./public.ts`.
 *
 * The two-step contract is the same one members use, for the same reason: a
 * presigned PUT cannot bound size or verify content type, so nothing is
 * attached to a plant until a confirm call has HeadObject'd the key. The
 * caretaker path adds no new leniency — the key is minted for the token's
 * household and the named plant, and `resolveIssuedImageKey` refuses anything
 * else, so a caretaker cannot attach an object to another household's plant
 * even with a crafted URL.
 *
 * The photo lands in the plant's normal timeline (so the household sees it
 * where photos already live), attributed to the caretaker by name, and is
 * also folded into the visit record as proof of the visit.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import {
  IMAGE_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  mintImageKey,
  publicImageUrl,
  resolveIssuedImageKey,
} from '../../services/plantImageRules.js';
import { s3, IMAGES_BUCKET } from '../../utils/s3.js';
import { successResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';
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

    const contentType = validatedBody?.contentType ?? 'image/jpeg';
    const key = mintImageKey(caretaker.householdId, plantId!, contentType);
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: 300 }
    );

    return successResponse({ uploadUrl, imageUrl: publicImageUrl(key) });
  }
)
  // Each presign invites an S3 PUT; anonymous, so cap harder than the member
  // path (20/min per user) does.
  .use(rateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(caretakerPhotoRequestSchema));

// POST /caretaker/{token}/plants/{plantId}/photo/confirm
//
// Verify the object landed within the size and content-type limits, then
// append it to the plant's timeline attributed to the caretaker, and record
// it on the visit.
export const confirmCaretakerPhoto = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<CaretakerPhotoConfirmInput>;
    const caretaker = await requireActiveCaretaker(event);
    const plantId = event.pathParameters?.plantId;
    const plant = await requireCaretakerPlant(caretaker.householdId, plantId);

    const key = resolveIssuedImageKey(caretaker.householdId, plantId!, validatedBody.imageUrl);
    if (!key) {
      throw createHttpError(400, 'imageUrl does not match a key issued for this plant');
    }

    let contentLength: number | undefined;
    let contentType: string | undefined;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }));
      contentLength = head.ContentLength;
      contentType = head.ContentType;
    } catch {
      throw createHttpError(400, 'Uploaded image not found; upload it before confirming');
    }
    if (contentLength === undefined || contentLength === 0 || contentLength > MAX_IMAGE_BYTES) {
      s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key })).catch((err) => {
        logger.warn({ err, key }, 'oversized_image_delete_failed');
      });
      throw createHttpError(
        400,
        contentLength === 0 ? 'Uploaded image is empty' : 'Image exceeds the 5 MiB limit'
      );
    }
    // The presigned PUT's Content-Type is client-claimed and not covered by
    // the S3 signature, so re-check the object's real type against the same
    // allowlist used at presign time.
    if (!contentType || !(contentType in IMAGE_CONTENT_TYPES)) {
      s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key })).catch((err) => {
        logger.warn({ err, key }, 'invalid_content_type_delete_failed');
      });
      throw createHttpError(400, 'Uploaded file is not a valid image');
    }

    const actorId = `caretaker:${caretaker.id}`;
    const photo = await plantService.appendPlantPhoto(
      caretaker.householdId,
      plantId!,
      validatedBody.imageUrl,
      actorId
    );

    const visitRecorded = await recordVisitAction(caretaker, {
      kind: 'photo',
      entry: {
        photoId: photo.id,
        plantId: plantId!,
        plantName: plant.name,
        imageUrl: validatedBody.imageUrl,
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

    return successResponse({ imageUrl: validatedBody.imageUrl, photo, visitRecorded });
  }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(caretakerPhotoConfirmSchema));
