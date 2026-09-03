import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware, AuthenticatedEvent } from '../../middleware/auth.js';
import * as householdService from '../../services/householdService.js';
import { buildCrossHomeToday, resolveEntitlement } from '../../services/crossHomeToday.js';
import {
  CROSS_HOME_TODAY_LOCKED_MESSAGE,
  CROSS_HOME_TODAY_UNVERIFIABLE_MESSAGE,
  InvalidUntilError,
  resolveCutoff,
} from '../../models/crossHomeToday.js';

// GET /me/today
// Cross-home Today (ADR 0017). Everything due today — by the caller's own
// end-of-day, sent as `?until=` — and anything overdue, across EVERY
// household the caller belongs to, each resolved with that household's
// membership role, GROUPED BY HOUSEHOLD with the household name on every
// row. Never a merged plant list. Not household-pinned: no requireHousehold,
// and X-Household-Id is irrelevant to the read — acting on a row goes back
// through the ordinary single-household task routes with an explicit
// X-Household-Id for that row's home. Greenhouse-gated (models/plans.ts):
// 402 when no household of the caller's includes it, 503 when that could
// not be determined. A household whose read fails comes back as an explicit
// `unavailable` entry, never dropped.
export const myToday = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;

    let cutoff: string;
    try {
      cutoff = resolveCutoff(event.queryStringParameters?.until ?? undefined);
    } catch (err) {
      if (err instanceof InvalidUntilError) throw createHttpError(400, err.message);
      throw err;
    }

    const memberships = await householdService.getMembershipsByUser(user.userId);
    const entitlement = await resolveEntitlement(memberships);
    if (entitlement === 'locked') {
      throw createHttpError(402, CROSS_HOME_TODAY_LOCKED_MESSAGE);
    }
    if (entitlement === 'unverifiable') {
      throw createHttpError(503, CROSS_HOME_TODAY_UNVERIFIABLE_MESSAGE, { expose: true });
    }

    const today = await buildCrossHomeToday(memberships, cutoff);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Personal and point-in-time; never let a shared cache hold it.
        'Cache-Control': 'private, no-store',
      },
      body: JSON.stringify(today),
    };
  }
).use(authMiddleware());
