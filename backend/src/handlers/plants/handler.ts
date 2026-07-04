import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import {
  createPlantSchema,
  updatePlantSchema,
  confirmImageUploadSchema,
  CreatePlantInput,
  UpdatePlantInput,
  ConfirmImageUploadInput,
} from '../../models/schemas.js';
import * as plantService from '../../services/plantService.js';
import * as taskService from '../../services/taskService.js';
import * as billing from '../../services/billing.js';
import * as activity from '../../services/activity.js';
import * as householdService from '../../services/householdService.js';
import { getPlan } from '../../models/plans.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { s3, IMAGES_BUCKET } from '../../utils/s3.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

/**
 * Resolve a display name for activity-feed rows from the denormalized
 * household member record (single DDB GetItem) instead of a per-request
 * Cognito AdminGetUser, which was adding ~100ms+ to every plant mutation.
 * Best-effort: activity attribution is advisory, so any miss/failure falls
 * back to 'Someone' rather than failing the mutation.
 */
async function resolveActorName(householdId: string, userId: string): Promise<string> {
  try {
    const member = await householdService.getMemberByUserId(householdId, userId);
    return member?.name || 'Someone';
  } catch (err) {
    logger.warn({ err }, 'actor_name_lookup_failed');
    return 'Someone';
  }
}

// GET /plants?filter=active|past|all  (default: active)
export const listPlants = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const raw = event.queryStringParameters?.filter;
    const filter: plantService.PlantFilter = raw === 'past' || raw === 'all' ? raw : 'active';
    const plants = await plantService.getPlants(user.householdId!, filter);
    return successResponse(plants);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /plants
export const createPlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreatePlantInput>;

    // Enforce per-tier plant cap. The "free" tier limits a household to 10
    // plants; paid tiers raise this dramatically. Enforcement is atomic in
    // the service: the plant Put rides a TransactWriteCommand with a
    // conditional increment of the household's active-plant counter, so
    // concurrent creates can't race past the cap (the old count-then-write
    // check was a verified TOCTOU). Legacy households without the counter
    // are backfilled lazily inside the service from the real (paginated)
    // active-plant count.
    const sub = await billing.getHouseholdSubscription(user.householdId!);
    const plan = getPlan(sub.planId);

    // Propagation: a cutting must point at a real plant in the SAME
    // household. (Self-reference is impossible on create — the new id
    // doesn't exist yet — but matters on update; see updatePlant.)
    let parentPlant: Awaited<ReturnType<typeof plantService.getPlant>> = null;
    if (validatedBody.parentPlantId) {
      parentPlant = await plantService.getPlant(user.householdId!, validatedBody.parentPlantId);
      if (!parentPlant) {
        throw createHttpError(400, 'Parent plant not found in this household');
      }
    }

    let plant: Awaited<ReturnType<typeof plantService.createPlant>>;
    try {
      plant = await plantService.createPlant(
        validatedBody,
        user.householdId!,
        user.userId,
        plan.maxPlants
      );
    } catch (err) {
      // Name check (not instanceof) so test automocks of the service module
      // keep working.
      if (err instanceof Error && err.name === 'PlanLimitError') {
        throw createHttpError(
          402,
          `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Upgrade to add more.`
        );
      }
      throw err;
    }

    // Best-effort activity event. We intentionally don't await failures
    // back to the user — losing one activity row is far better than
    // failing a plant create the user just successfully made.
    // A create WITH a parent records the more specific 'plant.propagated'
    // (instead of, not in addition to, 'plant.created' — one feed row per
    // create) so the feed can tell the propagation story.
    activity
      .recordActivity({
        type: parentPlant ? 'plant.propagated' : 'plant.created',
        householdId: user.householdId!,
        actorId: user.userId,
        actorName: await resolveActorName(user.householdId!, user.userId),
        payload: parentPlant
          ? {
              plantId: plant.id,
              plantName: plant.name,
              parentPlantId: parentPlant.id,
              parentPlantName: parentPlant.name,
            }
          : { plantId: plant.id, plantName: plant.name },
      })
      .catch((err) => {
        // Activity-stream rows are advisory, not load-bearing — losing one
        // doesn't affect correctness of the underlying mutation. Surfacing
        // the failure as a warn keeps "DDB is degrading" visible in
        // CloudWatch before the next mutation also fails.
        logger.warn({ err }, 'activity_record_failed');
      });

    return createdResponse(plant);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(createPlantSchema));

// GET /plants/:id
export const getPlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.id;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    const plant = await plantService.getPlant(user.householdId!, plantId);

    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    // Get upcoming tasks, recent completions, and propagation lineage
    // (parent link + cuttings taken from this plant — see getLineage for
    // the filter-the-household tradeoff note).
    const [upcomingTasks, recentCompletions, lineage] = await Promise.all([
      taskService.getTasksForPlant(user.householdId!, plantId),
      taskService.getTaskCompletions(user.householdId!, plantId, 10),
      plantService.getLineage(user.householdId!, plantId, plant.parentPlantId),
    ]);

    return successResponse({
      ...plant,
      upcomingTasks,
      recentCompletions,
      lineage,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// PUT /plants/:id
export const updatePlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UpdatePlantInput>;
    const plantId = event.pathParameters?.id;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    // Lineage edits: reject self-parenting and parents that don't exist in
    // this household. (null detaches and needs no validation.)
    if (validatedBody.parentPlantId) {
      if (validatedBody.parentPlantId === plantId) {
        throw createHttpError(400, 'A plant cannot be its own parent');
      }
      const parent = await plantService.getPlant(user.householdId!, validatedBody.parentPlantId);
      if (!parent) {
        throw createHttpError(400, 'Parent plant not found in this household');
      }
    }

    // Reactivating a plant (died/gave_away -> active) is cap-checked exactly
    // like createPlant — see plantService.updatePlant for why this can't be
    // left uncapped now that the active-plant count is an atomic counter.
    const sub = await billing.getHouseholdSubscription(user.householdId!);
    const plan = getPlan(sub.planId);

    let plant: Awaited<ReturnType<typeof plantService.updatePlant>>;
    try {
      plant = await plantService.updatePlant(
        user.householdId!,
        plantId,
        validatedBody,
        plan.maxPlants
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'PlanLimitError') {
        throw createHttpError(
          402,
          `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Upgrade to add more.`
        );
      }
      throw err;
    }

    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    // Record the lifecycle outcome on the activity feed (feeds the
    // plant-survival metric). Best-effort, same as plant.created.
    if (validatedBody.status === 'died' || validatedBody.status === 'gave_away') {
      activity
        .recordActivity({
          type: validatedBody.status === 'died' ? 'plant.died' : 'plant.gave_away',
          householdId: user.householdId!,
          actorId: user.userId,
          actorName: await resolveActorName(user.householdId!, user.userId),
          payload: { plantId: plant.id, plantName: plant.name },
        })
        .catch((err) => {
          logger.warn({ err }, 'activity_record_failed');
        });
    }

    return successResponse(plant);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(updatePlantSchema));

// DELETE /plants/:id
export const deletePlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.id;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    const plant = await plantService.deletePlant(user.householdId!, plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    audit('plant.deleted', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: plantId,
      householdId: user.householdId ?? undefined,
      metadata: { plantName: plant.name },
    });

    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// Allowlisted upload content types → file extension used in the S3 key.
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Hard cap enforced at confirm time (the presigned PUT itself can't bound
// size). Keep in sync with the frontend's client-side downscale target.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Body is optional: legacy clients POST with no body and get the jpeg default.
const imageUploadRequestSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  })
  .nullable();
type ImageUploadRequest = z.infer<typeof imageUploadRequestSchema>;

/**
 * Public base URL for a stored image key. When ASSETS_BASE_URL is set
 * (production: the site origin, served via the CloudFront /plants/* behavior)
 * we mint `${ASSETS_BASE_URL}/plants/...`; otherwise (local dev) we fall back
 * to the raw S3 URL form.
 */
function publicImageUrl(key: string): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  return `https://${IMAGES_BUCKET}.s3.amazonaws.com/${key}`;
}

// POST /plants/:id/image
// Returns a presigned PUT URL but does NOT yet attach the image to the plant.
// The client uploads to S3, then calls /image/confirm with the imageUrl. This
// avoids the race where a closed-tab upload leaves the plant with a broken URL.
//
// Contract: optional JSON body { contentType?: 'image/jpeg'|'image/png'|'image/webp' }
// (default image/jpeg; anything else is a 400). The presigned PUT is signed
// for exactly that Content-Type, and the key carries the matching extension.
export const getImageUploadUrl = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ImageUploadRequest>;
    const plantId = event.pathParameters?.id;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    const plant = await plantService.getPlant(user.householdId!, plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    const contentType = validatedBody?.contentType ?? 'image/jpeg';
    const ext = IMAGE_CONTENT_TYPES[contentType];
    const key = `plants/${user.householdId}/${plantId}/${uuid()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const imageUrl = publicImageUrl(key);

    return successResponse({ uploadUrl, imageUrl });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  // Each presign invites an S3 PUT; cap runaway clients.
  .use(userRateLimit({ perWindowMs: 60_000, max: 20 }))
  .use(validateBody(imageUploadRequestSchema));

// POST /plants/:id/image/confirm
// Called by the client after a successful S3 PUT. Verifies the imageUrl
// matches a prefix we mint (assets-domain form when ASSETS_BASE_URL is set,
// raw S3 form otherwise), HeadObjects the key to enforce the size cap, and
// only then writes it onto the plant.
export const confirmImageUpload = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ConfirmImageUploadInput>;
    const plantId = event.pathParameters?.id;
    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }
    const imageUrl = validatedBody.imageUrl;
    const keyPrefix = `plants/${user.householdId}/${plantId}/`;
    // Accept whichever URL forms we can mint; both map to the same S3 key.
    const assetsBase = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
    const expectedPrefixes = [`https://${IMAGES_BUCKET}.s3.amazonaws.com/${keyPrefix}`];
    if (assetsBase) expectedPrefixes.unshift(`${assetsBase}/${keyPrefix}`);
    const matchedPrefix = expectedPrefixes.find((p) => imageUrl.startsWith(p));
    if (!matchedPrefix) {
      throw createHttpError(400, 'imageUrl does not match a key issued for this plant');
    }
    // The remainder must look exactly like a key we minted (uuid.ext) — no
    // slashes, dots, or query strings smuggling a different object.
    const filename = imageUrl.slice(matchedPrefix.length);
    if (!/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(filename)) {
      throw createHttpError(400, 'imageUrl does not match a key issued for this plant');
    }
    const key = `${keyPrefix}${filename}`;
    const plant = await plantService.getPlant(user.householdId!, plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }
    // Verify the object actually landed and respects the size cap before we
    // attach it. The presigned PUT can't bound size, so this is where an
    // oversized upload gets rejected (and best-effort removed).
    let contentLength: number | undefined;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }));
      contentLength = head.ContentLength;
    } catch {
      throw createHttpError(400, 'Uploaded image not found; upload it before confirming');
    }
    if (contentLength === undefined || contentLength > MAX_IMAGE_BYTES) {
      s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key })).catch((err) => {
        logger.warn({ err, key }, 'oversized_image_delete_failed');
      });
      throw createHttpError(400, 'Image exceeds the 5 MiB limit');
    }
    // Append to the photo timeline (which atomically also updates plant.imageUrl
    // to the latest). The previous behavior of bare updatePlantImage is now
    // a degenerate case of this — there's no need for both.
    const photo = await plantService.appendPlantPhoto(
      user.householdId!,
      plantId,
      imageUrl,
      user.userId
    );
    activity
      .recordActivity({
        type: 'photo.uploaded',
        householdId: user.householdId!,
        actorId: user.userId,
        actorName: await resolveActorName(user.householdId!, user.userId),
        payload: { plantId, photoId: photo.id },
      })
      .catch((err) => {
        // Activity-stream rows are advisory, not load-bearing — losing one
        // doesn't affect correctness of the underlying mutation. Surfacing
        // the failure as a warn keeps "DDB is degrading" visible in
        // CloudWatch before the next mutation also fails.
        logger.warn({ err }, 'activity_record_failed');
      });
    return successResponse({ imageUrl, photo });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(confirmImageUploadSchema));

// GET /plants/:id/photos
export const listPhotos = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.id;
    if (!plantId) throw createHttpError(400, 'Plant ID is required');
    const photos = await plantService.getPlantPhotos(user.householdId!, plantId);
    return successResponse(photos);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// GET /plants/:plantId/history
export const getPlantHistory = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.plantId;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    const history = await taskService.getTaskCompletions(user.householdId!, plantId);

    return successResponse(history);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// ---------------------------------------------------------------------------
// Cutting shares (household → household)
// ---------------------------------------------------------------------------

// POST /plants/:id/share
//
// Mint a share code for a plant card. Any member may share (no admin gate —
// passing a cutting along is a member-level social action, like completing a
// task). The row stores a SNAPSHOT of the card, so later edits/deletes of
// the source plant never break the link. Rate-limited per user: share links
// invite external traffic, so cap runaway clients.
export const sharePlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.id;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    const share = await plantService.createPlantShare(user.householdId!, plantId, user.userId);
    if (!share) {
      throw createHttpError(404, 'Plant not found');
    }

    // Same base-URL policy as household invites: FRONTEND_URL, falling back
    // to ALLOWED_ORIGIN; refuse to mint a placeholder URL.
    const baseUrl = process.env.FRONTEND_URL || process.env.ALLOWED_ORIGIN;
    if (!baseUrl) {
      // expose: true — intentional config-error message, safe to show.
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate share URLs',
        { expose: true }
      );
    }

    return createdResponse({
      code: share.code,
      expiresAt: share.expiresAt,
      url: `${baseUrl}/shared/${share.code}`,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }));

// GET /plants/shared/:code
//
// PUBLIC (auth: none) by design — recipients of a share link usually don't
// have an account yet, exactly like invite previews. The response exposes
// no PII beyond the sharing household's display name and the plant card
// snapshot. IP rate-limited to slow code enumeration (the 128-bit code
// space is already unbruteforceable; this just caps probe volume).
export const getSharedPlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const code = event.pathParameters?.code;

    if (!code) {
      throw createHttpError(400, 'Share code is required');
    }

    const share = await plantService.getPlantShare(code);
    if (!share) {
      throw createHttpError(404, 'This share link is invalid or has expired');
    }

    const household = await householdService.getHousehold(share.householdId);

    return successResponse({
      plant: share.plantSnapshot,
      householdName: household?.name ?? 'A Family Greenhouse household',
      expiresAt: share.expiresAt,
    });
  }
).use(rateLimit({ perWindowMs: 60_000, max: 30 }));

// POST /plants/shared/:code/accept
//
// Copy the shared card into the CALLER's household via the normal
// createPlant path, so the plan cap applies (402 on overflow) and the copy
// behaves like any other plant. Notes:
//   - Multi-redeem is allowed within the TTL (see getPlantShare) — several
//     friends can each add the same cutting card.
//   - Accepting into the household the share came from is ALLOWED: it's a
//     harmless duplicate card, and blocking it would buy no safety for an
//     extra check. (It also makes trying the flow end-to-end trivial.)
//   - The image is NOT copied: the S3 object belongs to the source
//     household (and is swept if the source plant is hard-deleted), so the
//     copy starts without a photo rather than with a borrowed URL that can
//     rot.
export const acceptSharedPlant = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const code = event.pathParameters?.code;

    if (!code) {
      throw createHttpError(400, 'Share code is required');
    }

    const share = await plantService.getPlantShare(code);
    if (!share) {
      throw createHttpError(404, 'This share link is invalid or has expired');
    }

    const sourceHousehold = await householdService.getHousehold(share.householdId);
    const fromName = sourceHousehold?.name ?? 'another household';

    // Provenance note rides the plant's notes field, prefixed before the
    // shared notes; clamp to the createPlant contract's 1000-char cap.
    const prefix = `Cutting from ${fromName}`;
    const notes = (
      share.plantSnapshot.notes ? `${prefix}\n\n${share.plantSnapshot.notes}` : prefix
    ).slice(0, 1000);

    const sub = await billing.getHouseholdSubscription(user.householdId!);
    const plan = getPlan(sub.planId);

    let plant: Awaited<ReturnType<typeof plantService.createPlant>>;
    try {
      plant = await plantService.createPlant(
        {
          name: share.plantSnapshot.name,
          species: share.plantSnapshot.species ?? undefined,
          notes,
          tags: share.plantSnapshot.tags,
        },
        user.householdId!,
        user.userId,
        plan.maxPlants
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'PlanLimitError') {
        throw createHttpError(
          402,
          `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Upgrade to add more.`
        );
      }
      throw err;
    }

    // Activity lands in the ACCEPTING household's feed — best-effort, same
    // contract as plant.created.
    activity
      .recordActivity({
        type: 'plant.shared_accepted',
        householdId: user.householdId!,
        actorId: user.userId,
        actorName: await resolveActorName(user.householdId!, user.userId),
        payload: { plantId: plant.id, plantName: plant.name, fromHouseholdName: fromName },
      })
      .catch((err) => {
        logger.warn({ err }, 'activity_record_failed');
      });

    return createdResponse(plant);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit());

import { identify } from './identify.js';
import { importPlants } from './import.js';
import { checkPlantHealth } from './health.js';

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /plants': listPlants,
  'POST /plants': createPlant,
  'POST /plants/import': importPlants,
  // Cutting shares. NOTE: /plants/shared/{code} must be wired in API
  // Gateway with auth=none (public preview, like invite validation); the
  // other two are normal JWT routes.
  'GET /plants/shared/{code}': getSharedPlant,
  'POST /plants/shared/{code}/accept': acceptSharedPlant,
  'POST /plants/{id}/share': sharePlant,
  'GET /plants/{id}': getPlant,
  'PUT /plants/{id}': updatePlant,
  'DELETE /plants/{id}': deletePlant,
  'POST /plants/identify': identify,
  'POST /plants/{id}/health-check': checkPlantHealth,
  'POST /plants/{id}/image': getImageUploadUrl,
  'POST /plants/{id}/image/confirm': confirmImageUpload,
  'GET /plants/{id}/photos': listPhotos,
  'GET /plants/{plantId}/history': getPlantHistory,
});
