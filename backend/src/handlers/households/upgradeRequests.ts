/**
 * POST /households/{id}/upgrade-requests — a MEMBER asks the household's
 * admins to upgrade for a specific locked feature (brief §7d).
 *
 * Lives in the households group (same Lambda, same route table entry style)
 * but in its own file so the surfaces that gate paid features can adopt it
 * without touching the roster/invite handlers. Billing and checkout stay
 * `requireAdmin`: this route never sells anything, it only carries the ask.
 *
 * Refusals, all client-correctable and all exposed:
 *   403  caller is not a member of the addressed household
 *   409  caller is an admin (they can change the plan themselves), or the
 *        household already has the feature, or it has no admin to ask
 *   429  this member already asked for this feature inside the 7-day window
 *        (the body carries `nextAllowedAt` when the marker could be read)
 *   503  payment activity is paused — an ask the admin cannot act on is noise
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  rejectApiKeyPrincipal,
} from '../../middleware/auth.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import * as upgradeRequests from '../../services/upgradeRequests.js';
import { UPGRADE_FEATURES } from '../../models/upgradeFeatures.js';
import { paymentsAreAvailable } from '../../config/commercialStatus.js';
import { createdResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

export const upgradeRequestSchema = z.object({
  feature: z.enum(UPGRADE_FEATURES),
});

type UpgradeRequestBody = z.infer<typeof upgradeRequestSchema>;

// POST /households/:id/upgrade-requests
export const createUpgradeRequest = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UpgradeRequestBody>;
    const householdId = event.pathParameters?.id;

    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    // The ask is for people who cannot buy. An admin already can.
    if (user.householdRole === 'admin') {
      throw createHttpError(
        409,
        'You are an admin of this household — you can change the plan yourself in Settings → Billing.'
      );
    }
    // Same guard, same message as checkout: while payments are paused there
    // is nothing an admin could do with the request.
    if (!paymentsAreAvailable()) {
      throw createHttpError(503, 'Payments are currently paused.', { expose: true });
    }

    const appUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
    if (!appUrl) {
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to build upgrade-request links',
        { expose: true }
      );
    }

    let result: upgradeRequests.UpgradeRequestResult;
    try {
      result = await upgradeRequests.requestUpgrade({
        householdId,
        requester: { userId: user.userId, email: user.email },
        feature: validatedBody.feature,
        appUrl,
      });
    } catch (err) {
      // `err.name` (not instanceof) so a test automock of the service module
      // still maps — the same convention as PlanLimitError.
      const name = (err as { name?: string }).name;
      if (name === 'UpgradeRequestRateLimitedError') {
        const nextAllowedAt = (err as upgradeRequests.UpgradeRequestRateLimitedError).nextAllowedAt;
        throw createHttpError(429, (err as Error).message, {
          details: { nextAllowedAt },
        });
      }
      if (name === 'UpgradeAlreadyIncludedError' || name === 'NoHouseholdAdminError') {
        throw createHttpError(409, (err as Error).message);
      }
      logger.error({ err, householdId }, 'upgrade_request_failed');
      throw err;
    }

    audit('billing.upgrade_requested', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: {
        feature: result.feature,
        targetPlanId: result.targetPlanId,
        adminCount: result.admins.length,
        emailDelivered: result.emailDelivered,
        pushDelivered: result.pushDelivered,
      },
    });

    return createdResponse(result);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(rejectApiKeyPrincipal())
  // A brake on a runaway client only; the real once-a-week limit is the
  // DynamoDB marker inside the service.
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(upgradeRequestSchema));
