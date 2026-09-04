/**
 * Caretaker seats — the household-facing management surface.
 *
 * These routes are dispatched by the `households` Lambda group (see its
 * `createRouter` map), the same group that owns sitter links, because a
 * caretaker seat is the same kind of object: a credential the household mints
 * for someone outside it. Create/list/revoke are ADMIN-gated for exactly the
 * reason invites and sitter links are — they hand out access. The report is
 * available to any member: it is the household's own record of work done, and
 * §7(d) of the paid-feature brief is right that locking members out of things
 * they need is this product's recurring mistake.
 *
 * Gating: Greenhouse only, via `planHasFeature(planId, 'caretakerSeats')`.
 * The gate is on the CREATE path only. Listing, revoking and reporting stay
 * open on every tier so a household that downgrades can still see, stop, and
 * account for the seats it already handed out — a paywall that traps a live
 * credential inside an unreachable screen is a security bug, not an upsell.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { createCaretakerSchema, CreateCaretakerInput } from '../../models/caretakerSchemas.js';
import * as caretakerService from '../../services/caretakerService.js';
import { buildCaretakerReport, resolveReportRange } from '../../services/caretakerReport.js';
import * as billing from '../../services/billing.js';
import { planHasFeature } from '../../models/plans.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';

/** Default report window when the caller names neither end: the last 30 days. */
const DEFAULT_REPORT_DAYS = 30;

function requirePathHousehold(
  event: APIGatewayProxyEvent,
  user: { householdId?: string | null }
): string {
  const householdId = event.pathParameters?.id;
  if (!householdId) {
    throw createHttpError(400, 'Household ID is required');
  }
  if (user.householdId !== householdId) {
    throw createHttpError(403, 'Access denied');
  }
  return householdId;
}

async function requireCaretakerSeatsPlan(householdId: string): Promise<void> {
  const sub = await billing.getHouseholdSubscription(householdId);
  if (!planHasFeature(sub.planId, 'caretakerSeats')) {
    throw createHttpError(
      402,
      'Caretaker seats are included with the Greenhouse plan. Upgrade to add a caretaker.'
    );
  }
}

// POST /households/{id}/caretakers
//
// Mint a named, time-boxed caretaker seat. The token and its URL leave the
// building EXACTLY ONCE, here; list never returns them again.
export const createCaretaker = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreateCaretakerInput>;
    const householdId = requirePathHousehold(event, user);
    await requireCaretakerSeatsPlan(householdId);

    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
    if (!baseUrl) {
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate caretaker links',
        { expose: true }
      );
    }

    const caretaker = await caretakerService.createCaretaker({
      householdId,
      createdBy: user.userId,
      name: validatedBody.name,
      startsAt: validatedBody.startsAt ?? new Date().toISOString(),
      expiresAt: validatedBody.expiresAt,
    });

    audit('household.member_added', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: {
        stage: 'caretaker_created',
        caretakerId: caretaker.id,
        expiresAt: caretaker.expiresAt,
      },
    });

    return createdResponse({
      ...caretakerService.toSummary(caretaker),
      token: caretaker.token,
      url: `${baseUrl}/caretaker/${caretaker.token}`,
      permissions: caretakerService.CARETAKER_PERMISSIONS,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(createCaretakerSchema));

// GET /households/{id}/caretakers
//
// The household's seats for management. NEVER returns tokens.
export const listCaretakers = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requirePathHousehold(event, user);
    const caretakers = await caretakerService.listCaretakers(householdId);
    return successResponse(caretakers.map(caretakerService.toSummary));
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// DELETE /households/{id}/caretakers/{caretakerId}
//
// Revoke a seat by its non-secret id. Scoped to the household in the service,
// so one household can never revoke another's. Idempotent. Visits already
// recorded survive: they are the record of work that actually happened.
export const revokeCaretaker = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requirePathHousehold(event, user);
    const caretakerId = event.pathParameters?.caretakerId;
    if (!caretakerId) {
      throw createHttpError(400, 'Caretaker ID is required');
    }
    const revoked = await caretakerService.revokeCaretaker(householdId, caretakerId);
    if (!revoked) {
      throw createHttpError(404, 'Caretaker not found');
    }
    audit('household.member_removed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { stage: 'caretaker_revoked', caretakerId },
    });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// GET /households/{id}/caretaker-report
//
// Proof of visit for a date range: who came, when they arrived, what they
// did. Any member may pull it — it is the household's own record, and the
// person who needs to hand it to whoever is paying is not necessarily the
// admin. A failed read is NOT flattened into an empty report: the query is
// allowed to throw and the caller renders an error state (ADR 0010).
export const getCaretakerReport = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = requirePathHousehold(event, user);

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - DEFAULT_REPORT_DAYS * 24 * 60 * 60 * 1000);
    const from = event.queryStringParameters?.from ?? defaultFrom.toISOString();
    const to = event.queryStringParameters?.to ?? now.toISOString();

    const range = resolveReportRange(from, to);
    if (!range) {
      throw createHttpError(400, 'from and to must be valid dates, with to on or after from');
    }

    const visits = await caretakerService.listVisits(householdId, range.fromIso, range.toIso);
    return successResponse(
      buildCaretakerReport({
        householdId,
        from: range.fromIso,
        to: range.toIso,
        visits,
        generatedAt: now.toISOString(),
      })
    );
  }
)
  .use(authMiddleware())
  .use(requireHousehold());
