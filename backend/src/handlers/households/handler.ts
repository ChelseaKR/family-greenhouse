import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
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
  createSitterLinkSchema,
  CreateSitterLinkInput,
  setEscalationRuleSchema,
  SetEscalationRuleInput,
} from '../../models/schemas.js';
import * as householdService from '../../services/householdService.js';
import * as welcomeEmail from '../../services/welcomeEmail.js';
import * as inviteEmail from '../../services/inviteEmail.js';
import * as householdEmails from '../../services/householdEmails.js';
import * as taskService from '../../services/taskService.js';
import * as sitterService from '../../services/sitterService.js';
import * as caretakers from '../caretakers/management.js';
import * as cognitoUsers from '../../services/cognitoUsers.js';
import * as billing from '../../services/billing.js';
import * as activity from '../../services/activity.js';
import * as accountCleanup from '../../services/accountCleanup.js';
import * as escalation from '../../services/escalation.js';
import { getPlan, hasHouseholdToolkit, limitOf, type Plan } from '../../models/plans.js';
import {
  checkSitterLinkPlanGate,
  countLiveSitterLinks,
  sitterWindowDays,
} from '../../services/sitterPlanGate.js';
import * as doubleCare from '../../services/doubleCare.js';
import {
  assertCanAddHome,
  homesLimitMessage,
  type HomesLimitError,
} from '../../services/homesGate.js';
import { analyticsWindow } from '../../services/analyticsWindow.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import { createUpgradeRequest } from './upgradeRequests.js';
import { getAwayRecap } from './awayRecap.js';

async function sendFirstHouseholdWelcome(
  userId: string,
  email: string,
  userName: string
): Promise<void> {
  const appUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
  if (appUrl) {
    try {
      // The service owns a conditional, reclaimable delivery marker, so this
      // is safe on claim-repair retries as well as the original creation path.
      await welcomeEmail.sendWelcomeEmail(userId, email, userName, appUrl);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, userId, msg: 'welcome_email_failed' },
        'welcome_email_failed'
      );
    }
  } else {
    logger.warn(
      { userId, msg: 'welcome_email_skipped_no_base_url' },
      'welcome_email_skipped_no_base_url'
    );
  }
}

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
    // JWT custom claims can remain stale until the client refreshes after its
    // first household is created. Consult the membership index as well so a
    // quick second create cannot overwrite the original default household or
    // send a duplicate "one-time" welcome email.
    const memberships = await householdService.getMembershipsByUser(user.userId);
    const isFirstHousehold = !user.householdId && memberships.length === 0;

    if (!user.householdId && memberships.length > 0) {
      // Recovery path for the only non-transactional boundary in first
      // household creation: DynamoDB may have committed the household +
      // membership before Cognito rejected/timed out. A retry must repair that
      // authoritative default claim and return the existing household, never
      // create a second household and strand onboarding again.
      const firstMembership = [...memberships].sort(
        (a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.householdId.localeCompare(b.householdId)
      )[0];
      const existingHousehold = await householdService.getHousehold(firstMembership.householdId);
      if (!existingHousehold) {
        throw new Error(
          `Membership ${firstMembership.householdId} exists without household metadata`
        );
      }
      await cognitoUsers.setHouseholdClaims(
        user.userId,
        firstMembership.householdId,
        firstMembership.role
      );
      await sendFirstHouseholdWelcome(user.userId, user.email, userName);
      return createdResponse(existingHousehold);
    }

    // Homes gate (ADR 0014): a second home needs a plan that includes one.
    // The first household is always allowed — `memberships` is empty — and a
    // user already above the cap keeps every home they have and can act in
    // all of them; only this next one is refused.
    if (memberships.length > 0) {
      try {
        await assertCanAddHome(user.userId, { memberships });
      } catch (err) {
        if (err instanceof Error && err.name === 'HomesLimitError') {
          throw createHttpError(402, homesLimitMessage(err as HomesLimitError));
        }
        throw err;
      }
    }

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
    //
    // Membership state (not only the possibly stale JWT claim) is the
    // fire-once signal for the welcome email and default Cognito household.
    // Await the best-effort sender before returning: an un-awaited network
    // promise can be frozen as soon as Lambda completes, making welcomes
    // intermittent. Failures are still isolated so onboarding always wins.
    if (isFirstHousehold) {
      await cognitoUsers.setHouseholdClaims(user.userId, household.id, 'admin');
      await sendFirstHouseholdWelcome(user.userId, user.email, userName);
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

    // getHouseholdMembersPublic (NOT getHouseholdMembers) — the roster
    // response must never carry member emails, admin or not (Privacy Policy:
    // other members "cannot see your email").
    const [household, members] = await Promise.all([
      householdService.getHousehold(householdId),
      householdService.getHouseholdMembersPublic(householdId),
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
    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
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

/** Body for `POST /households/:id/invites/email`. Deliberately only an address
 *  and a language: no subject, no note, no free text of any kind. Anything the
 *  inviter could write is prose we would send on their behalf to someone who
 *  has not consented to hear from them. */
const inviteEmailSchema = z.object({
  email: z.string().trim().email().max(254),
  /** The inviter's UI language; the invitee has no stored preference because
   *  they have no account. */
  locale: z.enum(['en', 'es']).optional(),
});

type InviteEmailInput = z.infer<typeof inviteEmailSchema>;

/**
 * POST /households/:id/invites/email
 *
 * Mint an invite and email it. This is the missing first step of the product's
 * core loop: `createInvite` has always produced a link and the app has never
 * been able to send one, so `invite_sent → invite_accepted` could only happen
 * through whatever channel the inviter already had.
 *
 * Always returns the link as well as the outcome, so the UI degrades to the
 * existing copy-and-paste flow in every failure case rather than telling
 * someone an email went out when it did not. The response never says whether
 * the address belongs to an existing user or member: other members' email
 * addresses are not visible to admins anywhere else in the product (see
 * `getHouseholdMembersPublic`) and this endpoint is not the exception.
 */
// POST /households/:id/invites/email
export const emailInvite = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<InviteEmailInput>;
    const householdId = event.pathParameters?.id;

    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
    if (!baseUrl) {
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate invite URLs',
        { expose: true }
      );
    }

    // Read both identities BEFORE minting, so an invite that could not name
    // its sender never becomes a code sitting in the table.
    const [inviter, household] = await Promise.all([
      householdService.getMemberByUserId(householdId, user.userId),
      householdService.getHousehold(householdId),
    ]);
    if (!inviter?.name || !household?.name) {
      throw createHttpError(
        503,
        'We could not load your name or the household name, so we did not send an invitation that could not say who it was from. Generate a link instead.',
        { expose: true }
      );
    }

    const invite = await householdService.createInvite(householdId, user.userId);
    const url = `${baseUrl}/join/${invite.code}`;

    const status = await inviteEmail.sendInviteEmail({
      householdId,
      to: validatedBody.email,
      inviterName: inviter.name,
      householdName: household.name,
      joinUrl: url,
      expiresAt: invite.expiresAt,
      locale: validatedBody.locale,
    });

    if (status === 'rate_limited') {
      throw createHttpError(
        429,
        `This household has sent its ${inviteEmail.DAILY_INVITE_EMAIL_CAP} invite emails for today. The link below still works.`,
        { expose: true }
      );
    }

    audit('household.member_added', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { stage: 'invite_emailed', expiresAt: invite.expiresAt, status },
    });

    return createdResponse({
      code: invite.code,
      expiresAt: invite.expiresAt,
      url,
      // 'accepted' means SES took the message, which is not the same as
      // delivery — there is no bounce destination wired yet. The field is
      // named for what we know.
      status,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(inviteEmailSchema))
  // Sending mail to an address the service has never seen is the one action
  // here that reaches outside the household. The service enforces a household
  // daily cap and a per-address cooldown; this caps the caller as well, per
  // user rather than per IP so one household on a shared NAT cannot lock out
  // another.
  .use(userRateLimit({ perWindowMs: 60 * 60 * 1000, max: 10 }));

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

    // A member row can exist while the caller's default Cognito claim is
    // still missing if addMember committed and the subsequent Cognito write
    // timed out. Treat that exact state as an idempotent recovery: repair the
    // claim and return the household without incrementing memberCount again.
    // A caller that already has a default household still gets the ordinary
    // duplicate-join error.
    const existing = await householdService.getMemberByUserId(invite.householdId, user.userId);
    if (existing) {
      if (!user.householdId) {
        await cognitoUsers.setHouseholdClaims(user.userId, invite.householdId, existing.role);
        return successResponse(household);
      }
      throw createHttpError(400, 'You are already a member of this household');
    }

    // Homes gate (ADR 0014): joining counts the joined household's plan, so
    // a Greenhouse home always takes another hand, and a Seedling / Garden
    // home takes one only from someone who has no other home yet. A joiner
    // already above the cap keeps every home they have.
    try {
      await assertCanAddHome(user.userId, {
        joiningHouseholdId: invite.householdId,
        joiningPlanId: sub.planId,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'HomesLimitError') {
        throw createHttpError(402, homesLimitMessage(err as HomesLimitError));
      }
      throw err;
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
        limitOf(plan, 'members')
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
          `This household is on the ${plan.name} plan, limited to ${limitOf(plan, 'members')} members.`
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

    // Close the invite loop: `member.joined` has been a logged activity kind
    // all along and the person who minted the invite was never told it was
    // accepted. Awaited, not fire-and-forget — Lambda can freeze a dangling
    // promise the moment the handler returns — but every failure is swallowed
    // so joining a household can never fail because of an email.
    try {
      await householdEmails.notifyMemberJoined({
        householdId: invite.householdId,
        joinedUserId: user.userId,
        invitedBy: invite.createdBy,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, householdId: invite.householdId },
        'household_email.member_joined_failed'
      );
    }

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

/**
 * Double-care this month (household toolkit): confirmed duplicates counted
 * from the completion log. Three explicit states — a count, `not_in_plan`,
 * or `unavailable` when either the plan or the log could not be read — so
 * the analytics page never renders a failed read as "0 duplicates".
 */
/**
 * The household's plan as a SETTLED read (ADR 0010): either the plan, or an
 * explicit `unavailable`. Deliberately not `Plan | null` — a bare null would
 * be indistinguishable from "no plan / free tier" at the call site, which is
 * exactly the collapse that turns a failed read into a confident answer.
 */
type PlanRead = { status: 'ok'; plan: Plan } | { status: 'unavailable' };

async function readHouseholdPlan(householdId: string): Promise<PlanRead> {
  try {
    const { planId } = await billing.getHouseholdSubscription(householdId);
    return { status: 'ok', plan: getPlan(planId) };
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'household_plan_lookup_failed');
    return { status: 'unavailable' };
  }
}

async function confirmedDoubleCareThisMonth(
  planRead: PlanRead,
  householdId: string
): Promise<doubleCare.DoubleCareMonthly> {
  // A plan we could not read is an explicit absence, never a silent 0.
  if (planRead.status !== 'ok') return { status: 'unavailable' };
  if (!hasHouseholdToolkit(planRead.plan)) return { status: 'not_in_plan' };
  return doubleCare.countConfirmedDuplicatesThisMonth(householdId);
}

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
    const requestedDays = daysRaw ? Math.max(1, Math.min(180, parseInt(daysRaw, 10) || 30)) : 30;
    // ONE settled plan read serves both answers below — the analytics window
    // and the double-care roll-up — so a failed read is decided once, here,
    // and explicitly in both directions.
    const planRead = await readHouseholdPlan(householdId);
    // Analytics window (ADR 0014): the free tier renders the trailing
    // `analyticsHistoryDays`; paid tiers have no ceiling. Only the window a
    // request may ask for is narrowed — the completion rows are never
    // trimmed — and the response says which window applied so the client can
    // say why. `null` means "no limit". An unreadable plan is FAIL-OPEN on
    // this field: `undefined`, omitted from the body and read by the client
    // as "unknown", because publishing a guessed ceiling would silently
    // narrow a paid household's history. The roll-up below fails the other
    // way — `unavailable`, never a 0 — because there a guess reads as a real
    // count.
    const historyLimitDays =
      planRead.status === 'ok' ? limitOf(planRead.plan, 'analyticsHistoryDays') : undefined;
    const days =
      historyLimitDays == null ? requestedDays : Math.min(requestedDays, historyLimitDays);
    const [series, doubleCareMonthly] = await Promise.all([
      taskService.getDailyCompletionCounts(householdId, days),
      confirmedDoubleCareThisMonth(planRead, householdId),
    ]);
    return successResponse({ days, series, historyLimitDays, doubleCare: doubleCareMonthly });
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
    const plan = getPlan((await billing.getHouseholdSubscription(householdId)).planId);
    const historyLimitDays = limitOf(plan, 'analyticsHistoryDays');
    if (historyLimitDays === null) {
      const review = await taskService.getYearInReview(householdId, year);
      return successResponse({ ...review, historyLimitDays });
    }
    // Windowed (ADR 0014): the calendar year intersected with the trailing
    // window, so a past year on the free tier is honestly empty rather than
    // silently relabelled as "the last 30 days". The rows are never trimmed.
    const window = analyticsWindow(year, historyLimitDays);
    const review = await taskService.getCompletionReview(householdId, window.start, window.end);
    return successResponse({
      year,
      ...review,
      historyLimitDays,
      windowStart: window.start,
      windowEnd: window.end,
    });
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

    let updated;
    try {
      updated = await householdService.setMemberRole(householdId, userId, validatedBody.role);
    } catch (err) {
      // Service-layer last-admin guard (L1). Maps to the same 400 the handler
      // already returns for self-demotion.
      if (err instanceof Error && err.name === 'LastAdminError') {
        throw createHttpError(
          400,
          'Promote another member to admin before demoting the last admin'
        );
      }
      throw err;
    }
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

    try {
      await householdService.removeMember(householdId, userId);
    } catch (err) {
      // Service-layer last-admin guard (L1).
      if (err instanceof Error && err.name === 'LastAdminError') {
        throw createHttpError(
          400,
          'Promote another member to admin before removing the last admin'
        );
      }
      throw err;
    }
    // Member rows are only one half of departure. Clear every active task
    // assignment, vacation/cover relationship, and space default that still
    // points at the departed user, while anonymizing retained history.
    await accountCleanup.anonymizeUserInHousehold(householdId, userId);

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

// ---------------------------------------------------------------------------
// Plant-sitter links (authed management side)
// ---------------------------------------------------------------------------
//
// A household member generates a no-account, time-boxed link before they
// travel; a sitter opens it (the public /sitter/{token} routes live in the
// tasks group) to see due tasks and check them off. These three routes are
// the create / list / revoke surface, open to EVERY household member (ADR
// 0015): the traveller is rarely the admin, and a sitter link grants only a
// time-boxed, PII-free task view — far less than an invite, which stays
// admin-only. Widening who can mint tokens is balanced by the revocation
// model: an admin can revoke any of the household's links, a member only
// the ones they created, and every create/revoke is an activity event that
// names the actor so the household sees who opened a door and for how long.

// POST /households/{id}/sitter-links
//
// Create a link and return its token/URL EXACTLY ONCE — subsequent list calls
// never expose the token again (only the non-secret summary).
export const createSitterLink = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreateSitterLinkInput>;
    const householdId = event.pathParameters?.id;

    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
    if (!baseUrl) {
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate sitter link URLs',
        { expose: true }
      );
    }

    // Plan gate (ADR 0015): window length and live-link count are the
    // free/paid line. Seedling keeps one live link of up to seven days;
    // Garden/Greenhouse get 90-day windows and several links. Enforced here,
    // where the plan is known — the schema's 90-day cap is only the ceiling.
    const startsAt = validatedBody.startsAt ?? new Date().toISOString();
    const plan = getPlan((await billing.getHouseholdSubscription(householdId)).planId);
    const gate = checkSitterLinkPlanGate(plan, {
      windowDays: sitterWindowDays(startsAt, validatedBody.expiresAt),
      liveLinks: countLiveSitterLinks(await sitterService.listSitterLinks(householdId)),
    });
    if (!gate.ok) {
      throw createHttpError(402, gate.message);
    }

    const link = await sitterService.createSitterLink({
      householdId,
      createdBy: user.userId,
      startsAt,
      expiresAt: validatedBody.expiresAt,
      label: validatedBody.label ?? null,
    });

    audit('household.member_added', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { stage: 'sitter_link_created', linkId: link.id, expiresAt: link.expiresAt },
    });

    // Name the creator in the household feed. Any member can mint a link now,
    // so the rest of the household must be able to see who did and until when.
    const actorName = await cognitoUsers.getUserName(user.userId, user.email);
    activity
      .recordActivity({
        type: 'sitter_link.created',
        householdId,
        actorId: user.userId,
        actorName,
        payload: {
          linkId: link.id,
          label: link.label,
          startsAt: link.startsAt,
          expiresAt: link.expiresAt,
        },
      })
      .catch((err) => {
        logger.warn({ err }, 'activity_record_failed');
      });

    // The token leaves the building exactly once, here.
    return createdResponse({
      ...sitterService.toSummary(link),
      token: link.token,
      url: `${baseUrl}/sit/${link.token}`,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(createSitterLinkSchema));

// GET /households/{id}/sitter-links
//
// List the household's links for management. NEVER returns tokens — only the
// non-secret summary (id, window, status, label) so the UI can show + revoke.
export const listSitterLinks = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const links = await sitterService.listSitterLinks(householdId);
    return successResponse(links.map(sitterService.toSummary));
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// DELETE /households/{id}/sitter-links/{linkId}
//
// Revoke a link by its non-secret id. Scoped to the household in the service,
// so one household can never revoke another's link. Admins may revoke any of
// the household's links; a member only the ones they created. Idempotent.
export const revokeSitterLink = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    const linkId = event.pathParameters?.linkId;
    if (!householdId || !linkId) {
      throw createHttpError(400, 'Household ID and link ID are required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const target = await sitterService.findSitterLink(householdId, linkId);
    if (!target) {
      throw createHttpError(404, 'Sitter link not found');
    }
    if (user.householdRole !== 'admin' && target.createdBy !== user.userId) {
      throw createHttpError(
        403,
        'Only the member who created this sitter link, or a household admin, can revoke it'
      );
    }
    const revoked = await sitterService.revokeSitterLink(householdId, linkId);
    if (!revoked) {
      throw createHttpError(404, 'Sitter link not found');
    }
    audit('household.member_removed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { stage: 'sitter_link_revoked', linkId },
    });
    const actorName = await cognitoUsers.getUserName(user.userId, user.email);
    activity
      .recordActivity({
        type: 'sitter_link.revoked',
        householdId,
        actorId: user.userId,
        actorName,
        payload: {
          linkId: target.id,
          label: target.label,
          startsAt: target.startsAt,
          expiresAt: target.expiresAt,
        },
      })
      .catch((err) => {
        logger.warn({ err }, 'activity_record_failed');
      });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// Kiosk (wall display) link management. Separate file, same group: it mints a
// household-scoped credential exactly like the sitter links above.
import { issueKioskLink, getKioskLink, revokeKioskLink } from './kioskLink.js';
// PUT /households/{id}/escalation
//
// Auto-handoff rule (brief §4.4, ADR 0018): `{ escalateAfterDays: 5..60 | null }`.
// Admin-only (it turns on a new class of email for the whole household) and
// gated to plans with the household toolkit — 402, the same upgrade signal
// the plant cap uses. The 5-day floor is enforced by the schema here AND by
// the service, so no path can persist a lower value.
export const setEscalationRule = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SetEscalationRuleInput>;
    const householdId = event.pathParameters?.id;
    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const plan = getPlan((await billing.getHouseholdSubscription(householdId)).planId);
    if (!hasHouseholdToolkit(plan)) {
      throw createHttpError(
        402,
        `Auto-handoff is part of the household toolkit, which the ${plan.name} plan does not include. Upgrade to turn it on.`
      );
    }
    let escalateAfterDays: number | null;
    try {
      escalateAfterDays = await escalation.setEscalationRule(
        householdId,
        validatedBody.escalateAfterDays
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'EscalationRuleRangeError') {
        throw createHttpError(400, err.message);
      }
      if (err instanceof Error && err.name === 'HouseholdNotFoundError') {
        throw createHttpError(404, 'Household not found');
      }
      throw err;
    }
    audit('household.settings_changed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { setting: 'escalateAfterDays', value: escalateAfterDays },
    });
    return successResponse({ escalateAfterDays });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(setEscalationRuleSchema));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'POST /households': createHousehold,
  'GET /households/{id}': getHousehold,
  'POST /households/{id}/invites': createInvite,
  'POST /households/{id}/invites/email': emailInvite,
  'GET /households/invites/{inviteCode}': validateInvite,
  'POST /households/join/{inviteCode}': joinHousehold,
  'GET /households/{id}/activity': getActivity,
  'GET /households/{id}/analytics/daily': getDailyAnalytics,
  'GET /households/{id}/year-in-review': getYearInReview,
  'PUT /households/{householdId}/members/{userId}/role': updateMemberRole,
  'DELETE /households/{householdId}/members/{userId}': removeMember,
  'POST /households/{id}/sitter-links': createSitterLink,
  'GET /households/{id}/sitter-links': listSitterLinks,
  'DELETE /households/{id}/sitter-links/{linkId}': revokeSitterLink,
  'POST /households/{id}/kiosk-link': issueKioskLink,
  'GET /households/{id}/kiosk-link': getKioskLink,
  'DELETE /households/{id}/kiosk-link': revokeKioskLink,
  // Member → admin upgrade ask; documented in ./upgradeRequests.ts.
  'POST /households/{id}/upgrade-requests': createUpgradeRequest,
  'GET /households/{id}/away-recap': getAwayRecap,
  'PUT /households/{id}/escalation': setEscalationRule,
  // Caretaker seats (handlers/caretakers/management.ts) — same posture as
  // sitter links: create/list/revoke are admin-gated, the report is not.
  'POST /households/{id}/caretakers': caretakers.createCaretaker,
  'GET /households/{id}/caretakers': caretakers.listCaretakers,
  'DELETE /households/{id}/caretakers/{caretakerId}': caretakers.revokeCaretaker,
  'GET /households/{id}/caretaker-report': caretakers.getCaretakerReport,
});
