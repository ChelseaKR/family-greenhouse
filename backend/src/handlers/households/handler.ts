import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import {
  createHouseholdSchema,
  CreateHouseholdInput,
  updateMemberRoleSchema,
  UpdateMemberRoleInput,
} from '../../models/schemas.js';
import * as householdService from '../../services/householdService.js';
import * as taskService from '../../services/taskService.js';
import * as cognitoUsers from '../../services/cognitoUsers.js';
import * as billing from '../../services/billing.js';
import * as activity from '../../services/activity.js';
import { getPlan } from '../../models/plans.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';

// POST /households
//
// Users can belong to many households (Y2Q3 — see docs/multi-household.md).
// We only stamp the Cognito custom-attribute on their *first* household so
// the legacy "default household" path keeps working for clients that don't
// send X-Household-Id. Subsequent households are reachable via the
// switcher, which sets the header per-request.
export const createHousehold = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreateHouseholdInput>;

    const userName = await cognitoUsers.getUserName(user.userId, user.email);

    const household = await householdService.createHousehold(
      validatedBody,
      user.userId,
      userName,
      user.email
    );

    // Only set the JWT default if the user doesn't already have one. This
    // keeps the "first household stays default" property — switching to a
    // newer household requires the X-Household-Id header from the
    // frontend's HouseholdSwitcher.
    if (!user.householdId) {
      await cognitoUsers.setHouseholdClaims(user.userId, household.id, 'admin');
    }

    audit('household.created', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: household.id,
      metadata: { name: household.name },
    });

    return createdResponse(household);
  }
)
  .use(authMiddleware())
  .use(validateBody(createHouseholdSchema));

// GET /households/:id
export const getHousehold = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;

    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }

    // Verify user belongs to this household
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const [household, members] = await Promise.all([
      householdService.getHousehold(householdId),
      householdService.getHouseholdMembers(householdId),
    ]);

    if (!household) {
      throw createHttpError(404, 'Household not found');
    }

    return successResponse({
      ...household,
      members,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /households/:id/invites
export const createInvite = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;

    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }

    // Verify user belongs to this household and is admin
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const invite = await householdService.createInvite(householdId, user.userId);

    // Use ALLOWED_ORIGIN (== site_url, the user-facing URL) when FRONTEND_URL
    // isn't set explicitly. Refuse to emit a placeholder URL in production —
    // pre-fix, this defaulted to `family-greenhouse.example.com` and users got
    // invite links pointing at a non-existent domain.
    const baseUrl = process.env.FRONTEND_URL || process.env.ALLOWED_ORIGIN;
    if (!baseUrl) {
      // expose: true — intentional config-error message, safe to show.
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate invite URLs',
        { expose: true }
      );
    }

    audit('household.member_added', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { stage: 'invite_created', expiresAt: invite.expiresAt },
    });

    return createdResponse({
      code: invite.code,
      expiresAt: invite.expiresAt,
      url: `${baseUrl}/join/${invite.code}`,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// GET /households/invites/:inviteCode
//
// Unauthenticated by design — invite recipients haven't signed in yet. Rate-
// limited to slow code enumeration; the 128-bit (32-hex-char) code space is
// already too large to brute-force, but the limiter caps total per-IP probe
// volume to a tiny fraction of the keyspace per minute.
export const validateInvite = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const inviteCode = event.pathParameters?.inviteCode;

    if (!inviteCode) {
      throw createHttpError(400, 'Invite code is required');
    }

    const invite = await householdService.getInvite(inviteCode);

    if (!invite) {
      return successResponse({ valid: false });
    }

    const household = await householdService.getHousehold(invite.householdId);

    return successResponse({
      valid: true,
      household: household
        ? {
            id: household.id,
            name: household.name,
          }
        : null,
    });
  }
).use(rateLimit({ perWindowMs: 60_000, max: 30 }));

// POST /households/join/:inviteCode
export const joinHousehold = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const inviteCode = event.pathParameters?.inviteCode;

    if (!inviteCode) {
      throw createHttpError(400, 'Invite code is required');
    }

    const invite = await householdService.getInvite(inviteCode);

    if (!invite) {
      throw createHttpError(400, 'Invalid or expired invite');
    }

    const household = await householdService.getHousehold(invite.householdId);

    if (!household) {
      throw createHttpError(400, 'Household not found');
    }

    const sub = await billing.getHouseholdSubscription(invite.householdId);
    const plan = getPlan(sub.planId);

    const userName = await cognitoUsers.getUserName(user.userId, user.email);

    // Refuse a second join into the same household — there's already a
    // member row and we don't want to silently overwrite role state.
    const existing = await householdService.getMemberByUserId(invite.householdId, user.userId);
    if (existing) {
      throw createHttpError(400, 'You are already a member of this household');
    }

    // Member-cap enforcement is atomic in the service (formerly a known
    // check-then-write race here): the member Put rides a transaction with a
    // conditional increment of the household's memberCount against the
    // plan's cap. The two failure modes come back with distinct names.
    try {
      await householdService.addMember(
        invite.householdId,
        user.userId,
        userName,
        user.email,
        plan.maxMembers
      );
    } catch (err) {
      // A concurrent double-join (two tabs, double-tap) loses the race on
      // the member row's attribute_not_exists condition — surface the same
      // "already a member" answer as the pre-check above instead of
      // overwriting the winner's row.
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        throw createHttpError(400, 'You are already a member of this household');
      }
      // The memberCount increment lost against the plan cap.
      if (err instanceof Error && err.name === 'PlanLimitError') {
        throw createHttpError(
          402,
          `This household is on the ${plan.name} plan, limited to ${plan.maxMembers} members.`
        );
      }
      throw err;
    }
    // Same default-household rule as createHousehold: only stamp the JWT
    // on the first one. Subsequent joins are accessed via the switcher.
    if (!user.householdId) {
      await cognitoUsers.setHouseholdClaims(user.userId, invite.householdId, 'member');
    }

    audit('household.member_added', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: invite.householdId,
      metadata: { stage: 'joined', via: 'invite_code' },
    });

    activity
      .recordActivity({
        type: 'member.joined',
        householdId: invite.householdId,
        actorId: user.userId,
        actorName: userName,
        payload: { role: 'member' },
      })
      .catch((err) => {
        logger.warn({ err }, 'activity_record_failed');
      });

    return successResponse(household);
  }
).use(authMiddleware());

// GET /households/:id/activity
export const getActivity = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const limitRaw = event.queryStringParameters?.limit;
    const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
    // Activity is the union of TaskCompletion (legacy) + ActivityEvent rows.
    // The service returns them in the unified envelope shape so the frontend
    // renders them uniformly.
    const items = await activity.listActivity(householdId, limit);
    return successResponse(items);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// GET /households/:id/analytics/daily?days=N
export const getDailyAnalytics = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) throw createHttpError(400, 'Household ID is required');
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const daysRaw = event.queryStringParameters?.days;
    const days = daysRaw ? Math.max(1, Math.min(180, parseInt(daysRaw, 10) || 30)) : 30;
    const series = await taskService.getDailyCompletionCounts(householdId, days);
    return successResponse({ days, series });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// GET /households/:id/year-in-review?year=YYYY
export const getYearInReview = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) throw createHttpError(400, 'Household ID is required');
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const yearParam = event.queryStringParameters?.year;
    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();
    if (!Number.isFinite(year) || year < 2020 || year > 2100) {
      throw createHttpError(400, 'year must be between 2020 and 2100');
    }
    const review = await taskService.getYearInReview(householdId, year);
    return successResponse(review);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// PUT /households/:householdId/members/:userId/role
export const updateMemberRole = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UpdateMemberRoleInput>;
    const householdId = event.pathParameters?.householdId;
    const userId = event.pathParameters?.userId;

    if (!householdId || !userId) {
      throw createHttpError(400, 'Household ID and User ID are required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    if (user.userId === userId && validatedBody.role !== 'admin') {
      // An admin demoting themselves could lock the household out of admin
      // entirely. Refuse — the right flow is to promote someone else first.
      throw createHttpError(400, 'Admins cannot demote themselves');
    }

    const member = await householdService.getMemberByUserId(householdId, userId);
    if (!member) {
      throw createHttpError(404, 'Member not found');
    }

    const updated = await householdService.setMemberRole(householdId, userId, validatedBody.role);
    if (!updated) {
      throw createHttpError(404, 'Member not found');
    }

    // Only rewrite the target's Cognito claims when THIS household is their
    // current claim (default) household. Users belong to many households;
    // unconditionally stamping claims here would silently re-point a user's
    // default household to whichever one an admin last touched their role in.
    const claims = await cognitoUsers.getHouseholdClaims(userId);
    if (claims.householdId === householdId) {
      await cognitoUsers.setHouseholdClaims(userId, householdId, validatedBody.role);
    }

    audit('household.role_changed', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: userId,
      householdId,
      metadata: { newRole: validatedBody.role, oldRole: member.role },
    });

    return successResponse(updated);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(updateMemberRoleSchema));

// DELETE /households/:householdId/members/:userId
export const removeMember = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.householdId;
    const userId = event.pathParameters?.userId;

    if (!householdId || !userId) {
      throw createHttpError(400, 'Household ID and User ID are required');
    }

    // Verify user belongs to this household and is admin
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    // Cannot remove yourself
    if (user.userId === userId) {
      throw createHttpError(400, 'Cannot remove yourself from household');
    }

    // Verify member exists
    const member = await householdService.getMemberByUserId(householdId, userId);
    if (!member) {
      throw createHttpError(404, 'Member not found');
    }

    await householdService.removeMember(householdId, userId);

    // Claims hygiene. Removal from a SECONDARY household must not touch the
    // user's Cognito claims at all (the old unconditional clear logged users
    // out of their own default household when removed from any other one).
    // When the removed household IS their claim household, re-point the
    // claims at one of their remaining memberships, or clear if none remain.
    const claims = await cognitoUsers.getHouseholdClaims(userId);
    if (claims.householdId === householdId) {
      const remaining = await householdService.getMembershipsByUser(userId);
      const next = remaining.find((m) => m.householdId !== householdId);
      if (next) {
        await cognitoUsers.setHouseholdClaims(userId, next.householdId, next.role);
      } else {
        await cognitoUsers.clearHouseholdClaims(userId);
      }
    }

    audit('household.member_removed', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: userId,
      householdId,
      metadata: { removedEmail: member.email, removedRole: member.role },
    });

    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'POST /households': createHousehold,
  'GET /households/{id}': getHousehold,
  'POST /households/{id}/invites': createInvite,
  'GET /households/invites/{inviteCode}': validateInvite,
  'POST /households/join/{inviteCode}': joinHousehold,
  'GET /households/{id}/activity': getActivity,
  'GET /households/{id}/analytics/daily': getDailyAnalytics,
  'GET /households/{id}/year-in-review': getYearInReview,
  'PUT /households/{householdId}/members/{userId}/role': updateMemberRole,
  'DELETE /households/{householdId}/members/{userId}': removeMember,
});
