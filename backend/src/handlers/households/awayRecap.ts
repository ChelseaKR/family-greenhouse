/**
 * Away Kit return recap (ideation brief §4.1) — members-only read.
 *
 * `GET /households/{id}/away-recap[?linkId=…]` replays what a sitter link
 * did inside its window: tasks checked off, photos sent back, notes. Any
 * household member may read it (the sitter acted on the whole household's
 * plants), not only the admin who minted the link.
 *
 * Three distinct non-200 outcomes, each explicit so the page never shows an
 * empty recap as "nothing happened":
 *   402  the tier doesn't include the Away Kit (rendered as a locked state
 *        with the upgrade path — brief §7(d): members see what they hit);
 *   404  no sitter window has ended yet and no linkId was given;
 *   5xx  the activity read failed (rendered as "couldn't load").
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import {
  authMiddleware,
  requireHousehold,
  type AuthenticatedEvent,
} from '../../middleware/auth.js';
import { getEntitledPlan, planIncludesAwayKit } from '../../models/plans.js';
import * as billing from '../../services/billing.js';
import * as sitterService from '../../services/sitterService.js';
import {
  buildAwayRecap,
  listSitterWindowActivity,
  pickRecapLink,
} from '../../services/awayRecapService.js';
import { successResponse } from '../../utils/response.js';

// GET /households/:id/away-recap
export const getAwayRecap = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    // ENTITLEMENT, not the plan row (#476). Unlike the sitter's own routes,
    // this one is read by a MEMBER of the household, signed in, on their own
    // account — the person who can fix the card. Nothing is mid-flight: the
    // recap is only served for a window that has already ended. So it follows
    // the documented downgrade contract (a downgraded household loses the
    // Away Kit here too) rather than the already-issued-grant rule that keeps
    // the sitter's brief and photo-back alive.
    const sub = await billing.getHouseholdSubscription(householdId);
    if (!planIncludesAwayKit(getEntitledPlan(sub))) {
      throw createHttpError(402, 'The Away Kit is included with Garden and Greenhouse.');
    }

    const linkId = event.queryStringParameters?.linkId?.trim() || undefined;
    const now = new Date();
    const links = await sitterService.listSitterLinks(householdId);
    const link = pickRecapLink(links, linkId, now);
    if (!link) {
      throw createHttpError(
        404,
        linkId ? 'Sitter link not found' : 'No sitter window has ended yet'
      );
    }

    const { events, truncated } = await listSitterWindowActivity(householdId, link, now);
    return successResponse(buildAwayRecap(link, events, truncated, now));
  }
)
  .use(authMiddleware())
  .use(requireHousehold());
