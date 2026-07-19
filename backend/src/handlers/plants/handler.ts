import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import {
  createPlantSchema,
  updatePlantSchema,
  movePlantsSchema,
  confirmImageUploadSchema,
  createSpaceSchema,
  updateSpaceSchema,
  CreatePlantInput,
  UpdatePlantInput,
  MovePlantsInput,
  ConfirmImageUploadInput,
  CreateSpaceInput,
  UpdateSpaceInput,
} from '../../models/schemas.js';
import * as plantService from '../../services/plantService.js';
import * as spaceService from '../../services/spaceService.js';
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

// Hop cap on the ancestor-chain walk in updatePlant's cycle guard — see there.
const MAX_LINEAGE_DEPTH = 50;

// GET /spaces
export const listSpaces = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    return successResponse(await spaceService.getSpaces(user.householdId!));
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /spaces
export const createSpace = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreateSpaceInput>;
    try {
      const space = await spaceService.createSpace(validatedBody, user.householdId!, user.userId);
      return createdResponse(space);
    } catch (error) {
      if (error instanceof Error && error.name === 'DuplicateSpaceNameError') {
        throw createHttpError(409, error.message);
      }
      if (error instanceof Error && error.name === 'DefaultCaregiverNotMemberError') {
        throw createHttpError(400, error.message);
      }
      throw error;
    }
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(createSpaceSchema));

// PUT /spaces/:id
export const updateSpace = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UpdateSpaceInput>;
    const id = event.pathParameters?.id;
    if (!id) throw createHttpError(400, 'Space ID is required');
    try {
      const space = await spaceService.updateSpace(user.householdId!, id, validatedBody);
      if (!space) throw createHttpError(404, 'Space not found');
      return successResponse(space);
    } catch (error) {
      if (error instanceof Error && error.name === 'DuplicateSpaceNameError') {
        throw createHttpError(409, error.message);
      }
      if (error instanceof Error && error.name === 'DefaultCaregiverNotMemberError') {
        throw createHttpError(400, error.message);
      }
      throw error;
    }
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(updateSpaceSchema));

// DELETE /spaces/:id
export const deleteSpace = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const id = event.pathParameters?.id;
    if (!id) throw createHttpError(400, 'Space ID is required');
    const plants = await plantService.getPlants(user.householdId!, 'all');
    if (
      plants.some(
        (plant) => plant.spaceId === id || plant.summerSpaceId === id || plant.winterSpaceId === id
      )
    ) {
      throw createHttpError(
        409,
        'Remove this space from all current and seasonal plant homes before deleting it'
      );
    }
    if (!(await spaceService.deleteSpace(user.householdId!, id))) {
      throw createHttpError(404, 'Space not found');
    }
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

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

    if (
      validatedBody.spaceId &&
      !(await spaceService.getSpace(user.householdId!, validatedBody.spaceId))
    ) {
      throw createHttpError(400, 'Space not found in this household');
    }
    const seasonalSpaceIds = [validatedBody.summerSpaceId, validatedBody.winterSpaceId].filter(
      (spaceId): spaceId is string => Boolean(spaceId)
    );
    if (
      (
        await Promise.all(
          seasonalSpaceIds.map((spaceId) => spaceService.getSpace(user.householdId!, spaceId))
        )
      ).some((space) => !space)
    ) {
      throw createHttpError(400, 'Seasonal home not found in this household');
    }

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
          `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Remove or archive a plant before adding more.`
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

// POST /plants/move — one plant for a quick move, or up to 50 as a bulk move.
export const movePlants = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<MovePlantsInput>;

    if (
      validatedBody.spaceId &&
      !(await spaceService.getSpace(user.householdId!, validatedBody.spaceId))
    ) {
      throw createHttpError(400, 'Space not found in this household');
    }
    const plants = await Promise.all(
      validatedBody.plantIds.map((plantId) => plantService.getPlant(user.householdId!, plantId))
    );
    if (plants.some((plant) => !plant)) {
      throw createHttpError(404, 'One or more plants were not found');
    }

    return successResponse(await plantService.movePlants(user.householdId!, validatedBody));
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(movePlantsSchema));

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

    if (
      validatedBody.spaceId &&
      !(await spaceService.getSpace(user.householdId!, validatedBody.spaceId))
    ) {
      throw createHttpError(400, 'Space not found in this household');
    }
    const seasonalSpaceIds = [validatedBody.summerSpaceId, validatedBody.winterSpaceId].filter(
      (spaceId): spaceId is string => Boolean(spaceId)
    );
    if (
      (
        await Promise.all(
          seasonalSpaceIds.map((spaceId) => spaceService.getSpace(user.householdId!, spaceId))
        )
      ).some((space) => !space)
    ) {
      throw createHttpError(400, 'Seasonal home not found in this household');
    }

    // Lifecycle events need the pre-write state so idempotent PUT retries do
    // not create duplicate archive/restore feed entries. The service already
    // protects the write and active-plant counter; this read is only for the
    // human-facing event log.
    const lifecycleBefore = validatedBody.status
      ? await plantService.getPlant(user.householdId!, plantId)
      : null;

    // Lineage edits: reject self-parenting, parents that don't exist in this
    // household, and parents that would close a cycle. (null detaches and
    // needs no validation.)
    if (validatedBody.parentPlantId) {
      if (validatedBody.parentPlantId === plantId) {
        throw createHttpError(400, 'A plant cannot be its own parent');
      }
      const parent = await plantService.getPlant(user.householdId!, validatedBody.parentPlantId);
      if (!parent) {
        throw createHttpError(400, 'Parent plant not found in this household');
      }

      const current = await plantService.getPlant(user.householdId!, plantId);
      if (current?.parentPlantId !== validatedBody.parentPlantId) {
        // Cycle guard: walk the proposed parent's ancestors. If the walk
        // reaches back to `plantId`, the proposed parent is already a
        // descendant of this plant, so adopting it would close a cycle (the
        // literal self-parent check above only catches the 1-hop case).
        // Capped — real propagation chains never get remotely this deep, so
        // hitting the cap means a bug or a pathological chain; reject rather
        // than loop forever.
        let ancestorId = parent.parentPlantId;
        let hops = 0;
        while (ancestorId) {
          if (ancestorId === plantId) {
            throw createHttpError(
              400,
              'That plant is already a descendant of this one; setting it as parent would create a circular lineage'
            );
          }
          if (++hops >= MAX_LINEAGE_DEPTH) {
            throw createHttpError(400, 'Propagation chain is too long to validate');
          }
          const ancestor = await plantService.getPlant(user.householdId!, ancestorId);
          ancestorId = ancestor?.parentPlantId ?? null;
        }
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
          `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Remove or archive a plant before adding more.`
        );
      }
      throw err;
    }

    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    // Record real lifecycle transitions on the household story. Archive and
    // restore are operational events; died/gave-away additionally feed the
    // survival metric. Best-effort, same as plant.created.
    if (validatedBody.status && lifecycleBefore?.status !== plant.status) {
      const lifecycleType = {
        active: 'plant.restored',
        archived: 'plant.archived',
        died: 'plant.died',
        gave_away: 'plant.gave_away',
      }[validatedBody.status] as activity.ActivityType;
      activity
        .recordActivity({
          type: lifecycleType,
          householdId: user.householdId!,
          actorId: user.userId,
          actorName: await resolveActorName(user.householdId!, user.userId),
          payload: {
            plantId: plant.id,
            plantName: plant.name,
            previousStatus: lifecycleBefore?.status,
          },
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
    let contentType: string | undefined;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }));
      contentLength = head.ContentLength;
      contentType = head.ContentType;
    } catch {
      throw createHttpError(400, 'Uploaded image not found; upload it before confirming');
    }
    if (contentLength === undefined || contentLength > MAX_IMAGE_BYTES) {
      s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key })).catch((err) => {
        logger.warn({ err, key }, 'oversized_image_delete_failed');
      });
      throw createHttpError(400, 'Image exceeds the 5 MiB limit');
    }
    // The presigned PUT's Content-Type is client-claimed and NOT covered by
    // the S3 signature (Content-Type isn't a signable header), so the actual
    // upload can arrive with a different Content-Type than what was presigned
    // for. Re-check the object's real Content-Type against the same allowlist
    // used at presign time — otherwise a non-image object (e.g. text/html)
    // could be confirmed and later served same-origin as the plant's image.
    if (!contentType || !(contentType in IMAGE_CONTENT_TYPES)) {
      s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key })).catch((err) => {
        logger.warn({ err, key }, 'invalid_content_type_delete_failed');
      });
      throw createHttpError(400, 'Uploaded file is not a valid image');
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
    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
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
          `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Remove or archive a plant before adding more.`
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
  'GET /spaces': listSpaces,
  'POST /spaces': createSpace,
  'PUT /spaces/{id}': updateSpace,
  'DELETE /spaces/{id}': deleteSpace,
  'GET /plants': listPlants,
  'POST /plants': createPlant,
  'POST /plants/move': movePlants,
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
