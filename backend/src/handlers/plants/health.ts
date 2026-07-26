import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { IMAGE_BODY_MAX_BYTES } from '../../middleware/bodySize.js';
import * as plantService from '../../services/plantService.js';
import * as leafHealth from '../../services/leafHealth.js';
import * as leafHealthBudget from '../../services/leafHealthBudget.js';
import * as activity from '../../services/activity.js';
import * as householdService from '../../services/householdService.js';
import { successResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

// V1 keeps the identify transport: the image rides the request body as a
// data URL or bare base64, under the same 256 KiB body cap. A body without
// imageBase64 is a 400 — analyzing an existing timeline photo by reference
// is a possible V2, not supported here.
const healthCheckSchema = z.object({
  imageBase64: z.string().min(64).max(350_000, 'Image too large; resize to under 256 KB'),
});

type HealthCheckInput = z.infer<typeof healthCheckSchema>;

// POST /plants/{id}/health-check
//
// Metering decision: leaf-health checks are NOT counted against the identify
// monthly bucket. Identify metering exists because every Plant.id call burns
// a paid per-call credit; a leaf-health call is one Bedrock Haiku invocation
// (fractions of a cent). It is, however, real Bedrock spend, and the 5/min
// per-user rate limiter is in-memory per warm container (ceiling = N
// containers × max), so we add a durable monthly per-household spend cap
// (services/leafHealthBudget.ts, its own PK — cloned from the identifyBudget
// shape) mirroring the chat token-budget gate. Over-cap → 429.
export const checkPlantHealth = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<HealthCheckInput>;
    const plantId = event.pathParameters?.id;

    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    // Ownership: the lookup is household-scoped, so a plant in another
    // household is indistinguishable from a missing one — 404, same contract
    // as every other /plants/{id} route (no existence oracle).
    const plant = await plantService.getPlant(user.householdId!, plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    // Atomically reserve BEFORE the model call. A read-then-check gate lets
    // concurrent requests all invoke Bedrock before any one increments the
    // counter, so the conditional DynamoDB update is the real spend ceiling.
    const cap = leafHealthBudget.monthlyCap();
    const metered = cap > 0;
    if (metered) {
      try {
        await leafHealthBudget.reserveUsage(user.householdId!, cap);
      } catch (err) {
        if ((err as { name?: string }).name === 'LeafHealthBudgetExceededError') {
          throw createHttpError(
            429,
            "You've used this month's leaf-health check allowance. It resets on the 1st of next month."
          );
        }
        throw createHttpError(
          503,
          'Leaf-health checks are temporarily unavailable. Please try again.',
          { expose: true }
        );
      }
    }

    let assessment: leafHealth.LeafHealthAssessment;
    try {
      assessment = await leafHealth.assessLeafHealth(validatedBody.imageBase64);
    } catch (err) {
      // Both branches are intentionally exposed (5xx messages are hidden by
      // default) so the frontend can show why the check failed — mirrors the
      // identify handler's 502 contract.
      if (err instanceof Error && err.name === 'LeafHealthParseError') {
        throw createHttpError(
          502,
          'Could not analyze the photo. Try a clearer, closer shot of a single leaf.',
          { expose: true }
        );
      }
      throw createHttpError(502, `Leaf health check failed: ${(err as Error).message}`, {
        expose: true,
      });
    }

    // The explicit demo fallback means Bedrock rejected the deployment before
    // doing paid work, so return the reservation. Unlimited mode still tracks
    // successful real invocations for observability without enforcing a cap.
    if (assessment.demo && metered) {
      await leafHealthBudget.releaseUsage(user.householdId!);
    } else if (!assessment.demo && !metered) {
      await leafHealthBudget.incrementUsage(user.householdId!);
    }

    // Best-effort activity row, only on success — same fire-and-forget
    // contract as plant.created. Actor name resolves from the denormalized
    // member record (advisory; falls back to 'Someone').
    let actorName = 'Someone';
    try {
      const member = await householdService.getMemberByUserId(user.householdId!, user.userId);
      actorName = member?.name || 'Someone';
    } catch (err) {
      logger.warn({ err }, 'actor_name_lookup_failed');
    }
    activity
      .recordActivity({
        type: 'plant.health_checked',
        householdId: user.householdId!,
        actorId: user.userId,
        actorName,
        payload: { plantId: plant.id, plantName: plant.name, overall: assessment.overall },
      })
      .catch((err) => {
        logger.warn({ err }, 'activity_record_failed');
      });

    return successResponse(assessment);
  },
  { maxBodyBytes: IMAGE_BODY_MAX_BYTES }
)
  .use(authMiddleware())
  .use(requireHousehold())
  // Each call is a Bedrock vision invocation; 5/min per user covers any
  // legitimate "retake the photo" loop while capping runaway spend.
  .use(userRateLimit({ perWindowMs: 60_000, max: 5 }))
  .use(validateBody(healthCheckSchema));
