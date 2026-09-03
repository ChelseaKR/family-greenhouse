/**
 * Sitter photo-back (Away Kit, ideation brief §4.1) — the public routes.
 *
 * A plant sitter, holding only the time-boxed link token, can send a photo
 * of a plant back to the household. This is the one place the Away Kit
 * widens the UNAUTHENTICATED write surface, so the route is built as a
 * funnel of refusals, cheapest first, and nothing is stored until every
 * check has passed:
 *
 *   1. token → link      sitterService.getActiveLink: exists, not revoked,
 *                        now within [startsAt, expiresAt]. Generic 404 on
 *                        any miss (no token-existence oracle). An expired
 *                        link is refused here, on every call, regardless of
 *                        what the page showed a minute ago.
 *   2. IP brake          rateLimit middleware, 20/min per IP per route.
 *   3. token brake       10 uploads/min per token (per warm container).
 *   4. plan gate         the household's tier must include the Away Kit;
 *                        a Seedling household's link answers 402 and
 *                        nothing is written.
 *   5. scope             the taskId must resolve INSIDE the token's
 *                        household (scoped read — another household's task
 *                        is simply not found), and names the plant.
 *   6. bytes             strict base64 → ≤ 300 KB decoded → JPEG/PNG/WebP
 *                        by magic bytes (never a client header).
 *   7. quota             one conditional DynamoDB ADD reserves a slot under
 *                        the 60-per-link cap, atomically; 409 when full.
 *   8. store             S3 object under the household's existing per-plant
 *                        prefix with `via-sitter` metadata → PlantPhoto row
 *                        marked viaSitter → `photo.uploaded` activity event
 *                        with `viaSitter: true` and the link id.
 *
 * Any failure after 7 releases the slot (and after 8a discards the object)
 * so the cap counts stored photos, not attempts.
 *
 * What a sitter can NOT do through this route: change the plant's primary
 * image (timeline-only append), touch any other household, learn plant ids
 * or member identities (the response is the same PII-free projection as
 * the task view), or store anything that is not an image.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { validateBody, type ValidatedEvent } from '../../middleware/validation.js';
import { getPlan, planIncludesAwayKit } from '../../models/plans.js';
import * as sitterService from '../../services/sitterService.js';
import * as taskService from '../../services/taskService.js';
import * as plantService from '../../services/plantService.js';
import * as billing from '../../services/billing.js';
import { recordActivity } from '../../services/activity.js';
import {
  SITTER_PHOTO_BODY_MAX_BYTES,
  SITTER_PHOTO_MAX_PER_LINK,
  admitSitterPhoto,
  sitterActorId,
  sitterPhotoUploadSchema,
  takeSitterPhotoToken,
  type SitterPhotoUploadInput,
} from '../../services/sitterPhotoPolicy.js';
import {
  discardSitterPhoto,
  getSitterPhotoCount,
  releaseSitterPhotoSlot,
  reserveSitterPhotoSlot,
  storeSitterPhoto,
} from '../../services/sitterPhotoService.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';
import { createdResponse, successResponse } from '../../utils/response.js';

const SITTER_DISPLAY_NAME = 'a plant sitter';
const INACTIVE_LINK_MESSAGE = 'This sitter link is invalid or has expired.';

async function awayKitEnabledFor(householdId: string): Promise<boolean> {
  const sub = await billing.getHouseholdSubscription(householdId);
  return planIncludesAwayKit(getPlan(sub.planId));
}

// GET /sitter/:token/photos
//
// Whether photo-back is on for this link and how much of the cap is left,
// so the sitter page can show (or hide) the control before the first
// attempt. `used`/`remaining` are null when the count could not be read —
// the page must not render that as "0 of 60".
export const getSitterPhotoStatus = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const token = event.pathParameters?.token ?? '';
    const link = await sitterService.getActiveLink(token);
    if (!link) {
      throw createHttpError(404, INACTIVE_LINK_MESSAGE);
    }
    const enabled = await awayKitEnabledFor(link.householdId);
    if (!enabled) {
      return successResponse({
        enabled: false,
        max: SITTER_PHOTO_MAX_PER_LINK,
        used: null,
        remaining: null,
      });
    }
    const used = await getSitterPhotoCount(link.token);
    return successResponse({
      enabled: true,
      max: SITTER_PHOTO_MAX_PER_LINK,
      used,
      remaining: used === null ? null : Math.max(0, SITTER_PHOTO_MAX_PER_LINK - used),
    });
  }
).use(rateLimit({ perWindowMs: 60_000, max: 60 }));

// POST /sitter/:token/photos
export const uploadSitterPhoto = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<SitterPhotoUploadInput>;
    const token = event.pathParameters?.token ?? '';

    // 1. Token → link. Re-validated on every call: the window may have
    //    closed since the page loaded, and an expired link stores nothing.
    const link = await sitterService.getActiveLink(token);
    if (!link) {
      throw createHttpError(404, INACTIVE_LINK_MESSAGE);
    }

    // 3. Per-token brake (2, the IP brake, is middleware).
    if (!takeSitterPhotoToken(link.token)) {
      audit('rate_limit.tripped', { metadata: { key: `sitter-photo|${link.id}` } });
      throw createHttpError(429, 'Too many photos at once. Please wait a minute and try again.');
    }

    // 4. Plan gate — checked before any storage or quota write.
    if (!(await awayKitEnabledFor(link.householdId))) {
      throw createHttpError(402, 'Photo-back is not included in this household’s plan.');
    }

    // 5. Scope: the task must live in the token's household.
    const task = await taskService.getTask(link.householdId, validatedBody.taskId);
    if (!task) {
      throw createHttpError(404, 'Task not found');
    }
    const plant = await plantService.getPlant(link.householdId, task.plantId);
    if (!plant) {
      throw createHttpError(404, 'Task not found');
    }

    // 6. Bytes: strict decode, size, magic bytes.
    const admitted = admitSitterPhoto(validatedBody.image);
    if (!admitted.ok) {
      throw createHttpError(admitted.status, admitted.message);
    }

    // 7. Quota — atomic reservation under the per-link cap.
    const slot = await reserveSitterPhotoSlot(link.token);
    if (!slot.ok) {
      throw createHttpError(
        409,
        `This link has reached its ${SITTER_PHOTO_MAX_PER_LINK}-photo limit.`
      );
    }

    // 8. Store: object → timeline row → activity. Unwind on failure.
    let stored: { key: string; imageUrl: string } | undefined;
    try {
      stored = await storeSitterPhoto({
        householdId: link.householdId,
        plantId: plant.id,
        linkId: link.id,
        bytes: admitted.bytes,
        contentType: admitted.contentType,
      });
      const caption = validatedBody.caption?.trim() ? validatedBody.caption.trim() : null;
      const photo = await plantService.appendPlantPhoto(
        link.householdId,
        plant.id,
        stored.imageUrl,
        sitterActorId(link.id),
        caption,
        { viaSitter: { linkId: link.id }, setPrimaryImage: false }
      );

      await recordActivity({
        type: 'photo.uploaded',
        householdId: link.householdId,
        actorId: sitterActorId(link.id),
        actorName: SITTER_DISPLAY_NAME,
        payload: {
          plantId: plant.id,
          photoId: photo.id,
          plantName: plant.name,
          imageUrl: stored.imageUrl,
          caption,
          viaSitter: true,
          sitterLinkId: link.id,
        },
      });
      audit('sitter.photo_uploaded', {
        householdId: link.householdId,
        targetId: plant.id,
        metadata: { linkId: link.id, bytes: admitted.bytes.length, used: slot.used },
      });

      // PII-free acknowledgement: the sitter learns only what they sent. The
      // stored URL is deliberately NOT returned — its key path carries the
      // household and plant ids, which the sitter view never exposes.
      return createdResponse({
        photoId: photo.id,
        plantName: plant.name,
        caption,
        uploadedAt: photo.uploadedAt,
        used: slot.used,
        remaining: Math.max(0, SITTER_PHOTO_MAX_PER_LINK - slot.used),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, linkId: link.id }, 'sitter_photo.store_failed');
      if (stored) await discardSitterPhoto(stored.key);
      await releaseSitterPhotoSlot(link.token);
      throw err;
    }
  },
  { maxBodyBytes: SITTER_PHOTO_BODY_MAX_BYTES }
)
  // Anonymous, write side: tighter than the task view (60) and the task
  // completion (30). 20/min per IP absorbs a burst of a few photos.
  .use(rateLimit({ perWindowMs: 60_000, max: 20 }))
  .use(validateBody(sitterPhotoUploadSchema));

/** Route-table fragment the tasks group spreads into its router. */
export const sitterPhotoRoutes = {
  'GET /sitter/{token}/photos': getSitterPhotoStatus,
  'POST /sitter/{token}/photos': uploadSitterPhoto,
};
