/**
 * Seasonal Move Day endpoint (ideation brief §4.9). Lives in the climate
 * handler group because it is a reader of the climate cache: the dashboard
 * calls it right after GET /households/:id/climate has warmed the snapshot.
 * It never calls the weather provider itself — see services/moveDay.ts.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { successResponse } from '../../utils/response.js';
import { getPlan, planHasMoveDay } from '../../models/plans.js';
import * as billing from '../../services/billing.js';
import * as householdService from '../../services/householdService.js';
import * as moveDay from '../../services/moveDay.js';

// POST /households/:id/move-day
// Evaluate Move Day for the caller's household. Idempotent per season: may
// create claimable move tasks on the first call after the frost/heat line is
// crossed, returns the same list for two weeks, and is otherwise quiet.
// Garden+ only — free households get `locked` without any evaluation.
export const evaluateMoveDay = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id ?? user.householdId;
    if (!householdId) throw createHttpError(400, 'Household id required');
    // Same cross-household guard as getClimate: the X-Household-Id override
    // is membership-validated upstream, so equality is sufficient.
    if (householdId !== user.householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const household = await householdService.getHousehold(householdId);
    if (!household) throw createHttpError(404, 'Household not found');

    const plan = getPlan((await billing.getHouseholdSubscription(householdId)).planId);
    if (!planHasMoveDay(plan)) return successResponse({ status: 'locked' });

    const result = await moveDay.evaluateMoveDay(household, user.userId);
    return successResponse(result);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());
