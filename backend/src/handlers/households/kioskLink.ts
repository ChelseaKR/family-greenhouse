/**
 * Kiosk link management (authed, admin-gated, Greenhouse-gated).
 *
 * Issue / read / revoke the household's single wall-display token. The public
 * `/kiosk/{token}` routes live in the tasks group; the design rule and threat
 * model live at the top of `services/kioskService.ts`.
 *
 * Admin-gated for the same reason sitter links are: these routes mint a
 * credential that grants outside access. Greenhouse-gated per the paid-feature
 * brief §4.11 — the kiosk is the "many hands" tier's feature (offices, shared
 * houses, classrooms, plant shops).
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import * as kioskService from '../../services/kioskService.js';
import * as billing from '../../services/billing.js';
import { featureOf, getEntitledPlan } from '../../models/plans.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';

export const issueKioskLinkSchema = z
  .object({
    pollIntervalSeconds: z
      .number()
      .int()
      .min(kioskService.KIOSK_MIN_POLL_SECONDS)
      .max(kioskService.KIOSK_MAX_POLL_SECONDS)
      .optional(),
  })
  .nullish();
type IssueKioskLinkInput = z.infer<typeof issueKioskLinkSchema>;

/** Greenhouse-only. The gate reads the plan catalog (`features.kiosk`) rather
 *  than comparing a plan id, so a future tier that includes the kiosk is one
 *  boolean away. A failed billing read THROWS — it is never treated as
 *  "no entitlement" or as "entitled".
 *
 *  ENTITLEMENT, not the plan row (#476), and only on the ISSUE path — this
 *  helper has exactly one caller, `issueKioskLink` below. Mounting a NEW wall
 *  display is a new grant and follows the card. A screen already on the wall
 *  is never re-checked: `GET /kiosk/{token}` (handlers/tasks/kiosk.ts) has no
 *  plan gate at all, deliberately, for the same reason a printed plant tag
 *  does not — the display is a physical object in a room, and the people
 *  reading it are not the buyer. Revoke stays ungated, which is the control. */
async function requireKioskEntitlement(householdId: string): Promise<void> {
  const sub = await billing.getHouseholdSubscription(householdId);
  if (!featureOf(getEntitledPlan(sub), 'kiosk')) {
    throw createHttpError(
      402,
      'The kiosk display is included with the Greenhouse plan. Upgrade to set up a wall display.'
    );
  }
}

function requireHouseholdMatch(user: AuthenticatedEvent['user'], householdId: string | undefined) {
  if (!householdId) {
    throw createHttpError(400, 'Household ID is required');
  }
  if (user.householdId !== householdId) {
    throw createHttpError(403, 'Access denied');
  }
  return householdId;
}

// POST /households/{id}/kiosk-link
//
// Issue (or RE-issue) the household's kiosk link and return its token/URL
// exactly once. Re-issuing revokes the previous token in the same call, which
// is the household's one-click remedy for a photographed screen.
export const issueKioskLink = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<IssueKioskLinkInput>;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    await requireKioskEntitlement(householdId);

    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
    if (!baseUrl) {
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate kiosk link URLs',
        { expose: true }
      );
    }

    const link = await kioskService.issueKioskLink({
      householdId,
      createdBy: user.userId,
      pollIntervalSeconds: validatedBody?.pollIntervalSeconds,
    });

    audit('household.member_added', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: {
        stage: 'kiosk_link_issued',
        linkId: link.id,
        pollIntervalSeconds: link.pollIntervalSeconds,
      },
    });

    // The token leaves the building exactly once, here.
    return createdResponse({
      ...kioskService.toSummary(link),
      token: link.token,
      url: `${baseUrl}/kiosk/${link.token}`,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(issueKioskLinkSchema));

// GET /households/{id}/kiosk-link
//
// The household's current kiosk link, or `{ link: null }` when it has none.
// NEVER returns the token — the management screen shows only that a display
// is live, its poll interval, and a revoke button, so a screenshot of the
// settings page grants nothing.
//
// `link: null` means "we looked and there is none". A read failure propagates
// as a 5xx so the settings card can say so, rather than telling an admin no
// screen is watching their task list when it could not check (ADR 0010).
export const getKioskLink = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const link = await kioskService.getCurrentKioskLink(householdId);
    return successResponse({ link });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// DELETE /households/{id}/kiosk-link
//
// Revoke the household's kiosk link immediately. Deliberately NOT plan-gated:
// a household that downgrades must always be able to turn its wall display
// off, and revocation is a safety control — gating it would be indefensible.
export const revokeKioskLink = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requireHouseholdMatch(user, event.pathParameters?.id);
    const revoked = await kioskService.revokeKioskLinks(householdId);
    if (revoked === 0) {
      throw createHttpError(404, 'No active kiosk link to revoke');
    }
    audit('household.member_removed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { stage: 'kiosk_link_revoked', revoked },
    });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());
