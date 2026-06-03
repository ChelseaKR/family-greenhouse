import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
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
import * as cognitoUsers from '../../services/cognitoUsers.js';
import { getPlan } from '../../models/plans.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { s3, IMAGES_BUCKET } from '../../utils/s3.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

// GET /plants
export const listPlants = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plants = await plantService.getPlants(user.householdId!);
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
    // plants; paid tiers raise this dramatically. We count from the live
    // table rather than tracking a counter so re-imports / cascading deletes
    // can't drift the cap.
    const sub = await billing.getHouseholdSubscription(user.householdId!);
    const plan = getPlan(sub.planId);
    const existing = await plantService.getPlants(user.householdId!);
    if (existing.length >= plan.maxPlants) {
      throw createHttpError(
        402,
        `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Upgrade to add more.`
      );
    }

    const plant = await plantService.createPlant(validatedBody, user.householdId!, user.userId);

    // Best-effort activity event. We intentionally don't await failures
    // back to the user — losing one activity row is far better than
    // failing a plant create the user just successfully made.
    activity
      .recordActivity({
        type: 'plant.created',
        householdId: user.householdId!,
        actorId: user.userId,
        actorName: await cognitoUsers.getUserName(user.userId, user.email),
        payload: { plantId: plant.id, plantName: plant.name },
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

    // Get upcoming tasks and recent completions
    const [upcomingTasks, recentCompletions] = await Promise.all([
      taskService.getTasksForPlant(user.householdId!, plantId),
      taskService.getTaskCompletions(user.householdId!, plantId, 10),
    ]);

    return successResponse({
      ...plant,
      upcomingTasks,
      recentCompletions,
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

    const plant = await plantService.updatePlant(user.householdId!, plantId, validatedBody);

    if (!plant) {
      throw createHttpError(404, 'Plant not found');
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

// POST /plants/:id/image
// Returns a presigned PUT URL but does NOT yet attach the image to the plant.
// The client uploads to S3, then calls /image/confirm with the imageUrl. This
// avoids the race where a closed-tab upload leaves the plant with a broken URL.
export const getImageUploadUrl = createHandler(
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

    const key = `plants/${user.householdId}/${plantId}/${uuid()}.jpg`;

    const command = new PutObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: key,
      ContentType: 'image/jpeg',
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const imageUrl = `https://${IMAGES_BUCKET}.s3.amazonaws.com/${key}`;

    return successResponse({ uploadUrl, imageUrl });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /plants/:id/image/confirm
// Called by the client after a successful S3 PUT. Verifies the imageUrl matches
// the bucket prefix we minted and writes it onto the plant.
export const confirmImageUpload = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ConfirmImageUploadInput>;
    const plantId = event.pathParameters?.id;
    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }
    const imageUrl = validatedBody.imageUrl;
    const expectedPrefix = `https://${IMAGES_BUCKET}.s3.amazonaws.com/plants/${user.householdId}/${plantId}/`;
    if (!imageUrl.startsWith(expectedPrefix)) {
      throw createHttpError(400, 'imageUrl does not match a key issued for this plant');
    }
    const plant = await plantService.getPlant(user.householdId!, plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
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
        actorName: await cognitoUsers.getUserName(user.userId, user.email),
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

import { identify } from './identify.js';

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /plants': listPlants,
  'POST /plants': createPlant,
  'GET /plants/{id}': getPlant,
  'PUT /plants/{id}': updatePlant,
  'DELETE /plants/{id}': deletePlant,
  'POST /plants/identify': identify,
  'POST /plants/{id}/image': getImageUploadUrl,
  'POST /plants/{id}/image/confirm': confirmImageUpload,
  'GET /plants/{id}/photos': listPhotos,
  'GET /plants/{plantId}/history': getPlantHistory,
});
