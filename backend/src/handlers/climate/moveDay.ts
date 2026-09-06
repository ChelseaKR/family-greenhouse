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
import {
  getEntitledPlan,
  getEntitledPlanForIssuedGrant,
  planHasMoveDay,
} from '../../models/plans.js';
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

    // Two entitlement questions, not one (#476). A Move Day list is a GRANT
    // with an expiry: it claims the season, materialises claimable tasks, and
    // holds the card for MOVE_DAY_CARD_DAYS.
    //
    //   CONTINUING — an already-claimed season stays visible for its 14 days
    //   even if the card fails on day 3. A half-finished frost move is worse
    //   than either whole outcome: the tasks are already in the household's
    //   list and half the plants are already inside.
    //
    //   STARTING — firing a NEW season is a new grant and follows entitlement.
    //   This matters more than it looks: claiming a season consumes it for
    //   MOVE_DAY_REFIRE_GAP_DAYS (180), so a list fired for a household that
    //   is not entitled to see it would burn the claim for the whole season.
    //   Refusing to fire leaves the season UNCLAIMED, so the very next
    //   dashboard load after the card is fixed produces the list.
    const sub = await billing.getHouseholdSubscription(householdId);
    if (!planHasMoveDay(getEntitledPlanForIssuedGrant(sub))) {
      return successResponse({ status: 'locked' });
    }
    const mayFire = planHasMoveDay(getEntitledPlan(sub));

    const result = await moveDay.evaluateMoveDay(household, user.userId, new Date(), { mayFire });
    return successResponse(result);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());
