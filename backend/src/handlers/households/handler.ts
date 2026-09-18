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
  leaveHouseholdSchema,
  LeaveHouseholdInput,
  createSitterLinkSchema,
  CreateSitterLinkInput,
  setEscalationRuleSchema,
  SetEscalationRuleInput,
  setHouseholdTimeZoneSchema,
  SetHouseholdTimeZoneInput,
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
import * as householdDeparture from '../../services/householdDeparture.js';
import * as householdAudit from '../../services/householdAudit.js';
import {
  LEAVE_REFUSAL_CODES,
  LEAVE_REFUSAL_MESSAGES,
  isRenewingSubscription,
  rosterRefusal,
  type LeaveRefusalCode,
} from '../../services/leaveHouseholdRules.js';
import * as escalation from '../../services/escalation.js';
import * as coverage from '../../services/coverage.js';
import { getEntitledPlan, hasHouseholdToolkit, limitOf, type Plan } from '../../models/plans.js';
import {
  checkSitterLinkPlanGate,
  countLiveSitterLinks,
  sitterWindowDays,
} from '../../services/sitterPlanGate.js';
import * as doubleCare from '../../services/doubleCare.js';
import * as referrals from '../../services/referrals.js';
import {
  assertCanAddHome,
  homesLimitMessage,
  type HomesLimitError,
} from '../../services/homesGate.js';
import { analyticsWindow } from '../../services/analyticsWindow.js';
import { AUDIT_RETENTION_DAYS, toAuditEntryView } from '../../models/householdAudit.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import { createUpgradeRequest } from './upgradeRequests.js';
import { getAwayRecap } from './awayRecap.js';
import * as trash from './trash.js';

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

    // Refer-a-friend (ADR 0029): only a user's FIRST household can be a
    // referred signup — `isAddingAnother`/a second home is this same
    // account, not a new one, and gets no bonus either way. Resolving the
    // grant never throws and never refuses the household: a bad, expired,
    // or self-referred code just means no bonus (see resolveReferralGrant).
    const referralDecision =
      isFirstHousehold && validatedBody.referralCode
        ? await referrals.resolveReferralGrant({
            code: validatedBody.referralCode,
            newUserId: user.userId,
            newUserEmail: user.email,
          })
        : null;
    const referralGrant = referralDecision?.ok ? referralDecision.grant : null;

    const household = await householdService.createHousehold(
      validatedBody,
      user.userId,
      userName,
      user.email,
      new Date(),
      referralGrant
    );

    // Best-effort, after the new household is already committed: credits the
    // REFERRER's side and records the event for their "Refer a friend" list.
    // Never awaited into a failure the caller sees — see
    // `creditReferralAfterSignup`'s doc comment for why.
    if (referralGrant) {
      await referrals.creditReferralAfterSignup({
        grant: referralGrant,
        newHouseholdId: household.id,
      });
    }

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
      metadata: { name: household.name, referred: !!referralGrant },
    });
    await householdAudit.recordHouseholdAudit({
      householdId: household.id,
      kind: 'household.created',
      actor: { type: 'member', userId: user.userId },
      details: {},
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
    // The code itself is the credential and is never recorded.
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'invite.created',
      actor: { type: 'member', userId: user.userId },
      details: { channel: 'link', expiresAt: invite.expiresAt },
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

    // Recorded whatever the send's outcome: the invite exists either way. The
    // address belongs to someone who is not a member and is never recorded,
    // and neither is the code.
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'invite.created',
      actor: { type: 'member', userId: user.userId },
      details: { channel: 'email', expiresAt: invite.expiresAt },
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
    // Member cap follows ENTITLEMENT, not the plan row — see getEntitledPlan.
    const plan = getEntitledPlan(sub);

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
    await householdAudit.recordHouseholdAudit({
      householdId: invite.householdId,
      kind: 'member.joined',
      actor: { type: 'member', userId: user.userId },
      details: { role: 'member' },
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

// GET /households/:id/audit
//
// The household audit log (#675): who did what to the household itself —
// membership, the credentials that open a door into it, billing — newest
// first, one page at a time (`?limit=1..100&cursor=`). Admin-only: it is the
// record of the admin's own powers, and it names members' actions that the
// activity feed deliberately does not.
//
// Actors are resolved against the CURRENT roster: a member reads by display
// name, anyone who has left (or deleted their account) as a former member.
// The roster read is settled, not defaulted — if it fails the request fails,
// rather than presenting every entry as the work of a former member.
export const getHouseholdAuditLog = createHandler(
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
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw createHttpError(400, 'limit must be a positive integer');
    }
    const cursor = event.queryStringParameters?.cursor || null;

    let page: Awaited<ReturnType<typeof householdAudit.listHouseholdAudit>>;
    try {
      page = await householdAudit.listHouseholdAudit(householdId, { limit, cursor });
    } catch (err) {
      if (err instanceof Error && err.name === 'AuditCursorError') {
        throw createHttpError(400, 'Invalid cursor');
      }
      throw err;
    }
    // Only id and display name leave this function; the rows' emails do not.
    const roster = (await householdService.getHouseholdMembers(householdId)).map((m) => ({
      userId: m.userId,
      name: m.name,
    }));

    return successResponse({
      retentionDays: AUDIT_RETENTION_DAYS,
      items: page.items.map((item) => toAuditEntryView(item, householdId, roster)),
      nextCursor: page.nextCursor,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

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
    // ENTITLEMENT, not the plan row (#476). The analytics history window is a
    // plan LIMIT, and a downgrade already narrows it (ADR 0014); a household
    // mid-dunning is treated the same way rather than keeping the paid
    // window for the weeks Stripe spends retrying. The rows are never
    // trimmed, so nothing is lost — only the window a request may ask for.
    return {
      status: 'ok',
      plan: getEntitledPlan(await billing.getHouseholdSubscription(householdId)),
    };
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

// GET /households/:id/analytics/coverage
//
// The bus-factor view: which plants rest on one person, and what an upcoming
// vacation window leaves uncovered. Garden-and-up (the household toolkit).
// Deliberately NOT a leaderboard — the report carries no per-member totals
// and no ranking; see services/coverageMath.ts for the rule and the reasoning.
export const getCoverage = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) throw createHttpError(400, 'Household ID is required');
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    // ENTITLEMENT, not the plan row (#476). A per-request report for a
    // signed-in member of the buying household — nothing issued, nothing in a
    // third party's hands — so it follows the downgrade contract.
    const plan = getEntitledPlan(await billing.getHouseholdSubscription(householdId));
    if (!hasHouseholdToolkit(plan)) {
      throw createHttpError(
        402,
        'Coverage is part of the household toolkit, included with the Garden plan and up.'
      );
    }
    // A failed read throws here and surfaces as a 5xx — never as a report
    // claiming zero plants at risk.
    const report = await coverage.getCoverageReport(householdId);
    return successResponse(report);
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
    const year = yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear();
    if (!Number.isFinite(year) || year < 2020 || year > 2100) {
      throw createHttpError(400, 'year must be between 2020 and 2100');
    }
    // ENTITLEMENT, not the plan row (#476) — the same window limit as the
    // daily analytics above, resolved the same way. Completion rows are never
    // trimmed; only the window this request may ask for narrows.
    const plan = getEntitledPlan(await billing.getHouseholdSubscription(householdId));
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
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'member.role_changed',
      actor: { type: 'member', userId: user.userId },
      targetUserId: userId,
      details: { from: member.role, to: validatedBody.role },
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

    // The shared departure sequence (services/householdDeparture.ts): the
    // member row under the last-admin guard, then credential revocation
    // STRICTLY BEFORE anonymisation (#449 — the sweep overwrites `createdBy`
    // on exactly the rows revocation must find), then task/rotation/vacation
    // cleanup, then claims hygiene that only moves the default when this was
    // it. Self-leave (#686) runs the same function, so the two cannot drift.
    let departure: householdDeparture.DepartureResult;
    try {
      departure = await householdDeparture.departHousehold(householdId, userId);
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
    const revoked = departure.revokedCredentials;

    audit('household.member_removed', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: userId,
      householdId,
      metadata: {
        removedEmail: member.email,
        removedRole: member.role,
        // What departure actually cost the household, so the revocation is
        // reconstructable after the fact rather than only inferable.
        revokedCredentials: revoked,
      },
    });
    // The revocation cascade (#449) rides the same entry as counts, so the
    // admin can see what the removal cost without the entry naming a token.
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'member.removed',
      actor: { type: 'member', userId: user.userId },
      targetUserId: userId,
      details: { role: member.role, ...revoked },
    });

    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin());

// ---------------------------------------------------------------------------
// Leaving a household (#686)
// ---------------------------------------------------------------------------
//
// A member leaves one household and keeps their account and every other
// household. It is removal seen from the other side — the same departure
// sequence runs (services/householdDeparture.ts) — plus the three states
// removal never had to answer because an admin cannot remove themselves:
//
//   - LAST_MEMBER. The only member leaving would leave a household with plants,
//     history and possibly a paid plan and nobody in it. Refused: invite and
//     promote someone first, or delete the account (which is the existing,
//     documented path for abandoning a household — docs/multi-household.md).
//     The household is never ended or deleted by a leave.
//   - LAST_ADMIN. The lone admin of a household with other members would lock
//     it out of admin. Refused here on a read-only pre-check, AND by the
//     TOCTOU-safe guard inside householdService.removeMember (two admins
//     leaving at once cannot both succeed).
//   - BILLING_ACK_REQUIRED. Leaving never touches billing: subscriptions belong
//     to households, and a household that keeps members keeps its plan. But an
//     ADMIN leaving a household whose Stripe subscription will renew may be
//     leaving their own card on it, and after leaving they cannot reach this
//     household's Settings → Billing (billing routes are admin-only, so a plain
//     member can never be in this position). That admin is refused until they
//     send `acknowledgeBilling: true` — the refusal IS the warning, and the
//     client shows it before offering "leave anyway".
//
// Instant, like removal and DELETE /me: the confirm dialog is the fat-finger
// guard, and a grace window an admin can see would defeat the point of the
// route, which is leaving without having to ask the admin.

/** A 409 whose `details.code` the client words in the user's language. */
function leaveRefusal(code: LeaveRefusalCode, extra: Record<string, unknown> = {}) {
  return createHttpError(409, LEAVE_REFUSAL_MESSAGES[code], { details: { code, ...extra } });
}

// POST /households/{id}/leave
export const leaveHousehold = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<LeaveHouseholdInput>;
    const householdId = event.pathParameters?.id;

    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    // Self only. The leaver is the authenticated caller — never a body or path
    // field — and the path must name the household the request resolved to
    // (X-Household-Id, validated against the membership row by authMiddleware).
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const member = await householdService.getMemberByUserId(householdId, user.userId);
    if (!member) {
      throw createHttpError(404, 'You are not a member of this household');
    }
    const members = await householdService.getHouseholdMembers(householdId);

    const refusal = rosterRefusal(user.userId, members);
    if (refusal) {
      throw leaveRefusal(refusal);
    }

    if (member.role === 'admin' && validatedBody?.acknowledgeBilling !== true) {
      // A read that fails here throws, and the leave is refused as a 500 with
      // nothing changed: an unread subscription is not "no subscription".
      const subscription = await billing.getHouseholdSubscription(householdId);
      if (isRenewingSubscription(subscription)) {
        throw leaveRefusal(LEAVE_REFUSAL_CODES.billingAckRequired, {
          planId: subscription.planId,
          currentPeriodEnd: subscription.currentPeriodEnd ?? null,
        });
      }
    }

    // Read before anything changes: after the departure the leaver can no
    // longer read this household. The name only feeds the leaver's own
    // confirmation email, whose copy renders `null` as "a household" — true
    // whether the read failed or the row had no name — so a failed read is
    // settled explicitly as that acknowledged unknown, never as a reason to
    // refuse a leave the person has already confirmed.
    let householdName: string | null;
    try {
      householdName = (await householdService.getHousehold(householdId))?.name?.trim() || null;
    } catch (err) {
      householdName = null;
      logger.warn(
        { err: (err as Error).message, householdId, msg: 'household_leave.name_read_failed' },
        'household_leave.name_read_failed'
      );
    }

    let departure: householdDeparture.DepartureResult;
    try {
      departure = await householdDeparture.departHousehold(householdId, user.userId);
    } catch (err) {
      // Lost the race to another admin leaving or being demoted at the same
      // moment: the service guard refused inside the transaction.
      if (err instanceof Error && err.name === 'LastAdminError') {
        throw leaveRefusal(LEAVE_REFUSAL_CODES.lastAdmin);
      }
      throw err;
    }
    const { releasedTasks } = departure.cleanup;

    // The household's own record of the departure. Written ALREADY anonymised:
    // the sweep above rewrote every earlier event of theirs to "Former member",
    // and a row written after it that named them would undo that contract.
    // (Writing it before the sweep would race the sweep's GSI read instead.)
    try {
      await activity.recordActivity({
        type: 'member.left',
        householdId,
        actorId: accountCleanup.DELETED_USER_ID,
        actorName: accountCleanup.DELETED_USER_NAME,
        payload: { role: member.role, releasedTasks },
      });
    } catch (err) {
      logger.warn({ err }, 'activity_record_failed');
    }

    audit('household.member_left', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: user.userId,
      householdId,
      metadata: {
        role: member.role,
        releasedTasks,
        rotationsUpdated: departure.cleanup.rotationsUpdated,
        helpAsksAnonymized: departure.cleanup.helpAsksAnonymized,
        revokedCredentials: departure.revokedCredentials,
        billingAcknowledged: validatedBody?.acknowledgeBilling === true,
      },
    });
    // The leaver is no longer on the roster, so the page names them "former
    // member" — the same contract the activity feed keeps.
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'member.left',
      actor: { type: 'member', userId: user.userId },
      details: { role: member.role, releasedTasks, ...departure.revokedCredentials },
    });

    // Emails. Awaited (a dangling promise can be frozen with the Lambda) but
    // never allowed to fail a departure that has already happened.
    try {
      await householdEmails.notifyMemberLeft({
        householdId,
        leftUserId: user.userId,
        memberName: member.name?.trim() || null,
        releasedTasks,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, householdId },
        'household_email.member_left_failed'
      );
    }

    // `null` is "could not read", never "none": the success path always yields
    // a number, and the confirmation below is skipped rather than sent with a
    // guessed count.
    let remainingHouseholds: number | null;
    try {
      remainingHouseholds = (await householdService.getMembershipsByUser(user.userId)).filter(
        (m) => m.householdId !== householdId
      ).length;
    } catch (err) {
      remainingHouseholds = null;
      logger.warn(
        {
          err: (err as Error).message,
          householdId,
          msg: 'household_leave.memberships_read_failed',
        },
        'household_leave.memberships_read_failed'
      );
    }
    // The confirmation says how many households remain; with that count
    // unknown it would have to guess, so it is not sent rather than sent wrong.
    if (remainingHouseholds !== null) {
      await householdEmails.sendLeaveConfirmation({
        userId: user.userId,
        email: user.email,
        householdName,
        releasedTasks,
        remainingHouseholds,
      });
    }

    return successResponse({
      householdId,
      releasedTasks,
      revokedCredentials: departure.revokedCredentials,
      defaultHouseholdId: departure.defaultHouseholdId,
      defaultHouseholdRole: departure.defaultHouseholdRole,
      remainingHouseholds,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(leaveHouseholdSchema));

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
    //
    // ENTITLEMENT, not the plan row (#476). This is the ISSUING half of the
    // sitter-link decision and the piece that makes the other half safe: a
    // household mid-dunning cannot mint a new link or a longer window, while
    // a link it already handed out keeps working to its expiry (see
    // handlers/tasks/handler.ts and handlers/tasks/sitterPhotos.ts). Starting
    // is gated on the card; continuing is not.
    const startsAt = validatedBody.startsAt ?? new Date().toISOString();
    const plan = getEntitledPlan(await billing.getHouseholdSubscription(householdId));
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
    // The link's id and window only: the token leaves in the response below
    // and nowhere else, and the free-text label is not the log's to keep.
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'sitter_link.created',
      actor: { type: 'member', userId: user.userId },
      details: { linkId: link.id, startsAt: link.startsAt, expiresAt: link.expiresAt },
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
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'sitter_link.revoked',
      actor: { type: 'member', userId: user.userId },
      details: { linkId: target.id },
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
    // ENTITLEMENT, not the plan row (#476). Turning auto-handoff ON is a new
    // grant — it starts a new class of email for the whole household — so a
    // household mid-dunning may not. A rule already stored keeps its row and
    // is separately gated at scan time in services/escalation.ts, so nothing
    // has to be cleaned up and nothing is lost when the card is fixed.
    const plan = getEntitledPlan(await billing.getHouseholdSubscription(householdId));
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

// PUT /households/{id}/timezone
//
// The household's IANA timezone (#342, ADR 0025). `{ timezone: "" }` clears it
// back to "never set", which is NOT the same as choosing `"UTC"`.
//
// Stored and readable, and read by nothing. Due dates are still ISO instants
// compared in the Lambda's zone on every surface — `taskService.completeTask`,
// the 7-day upcoming window, the ICS all-day date, the digest's days-overdue.
// (The reminder scan's send DAY follows each member's own notification zone
// since #343, not this field.) Making any of those consult this
// field reinterprets `nextDue` for every task already in production, and ADR
// 0025 is the plan for that decision rather than this route.
//
// Admin-only, like the location card next to which it will live: a zone is
// shared by the whole household, not a per-member preference (members already
// have their own for quiet hours). Deliberately NOT plan-gated — this is
// correctness, not a feature, and `PUT /households/{id}/escalation`'s 402 is
// there because auto-handoff starts a new class of email.
export const setHouseholdTimeZone = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SetHouseholdTimeZoneInput>;
    const householdId = event.pathParameters?.id;
    if (!householdId) {
      throw createHttpError(400, 'Household ID is required');
    }
    // `requireAdmin()` only proves the caller is an admin of their OWN
    // household; without this equality check they could set any other
    // household's zone (the same guard `setLocation` documents).
    if (user.householdId !== householdId) {
      throw createHttpError(403, 'Access denied');
    }
    const household = await householdService.setHouseholdTimeZone(
      householdId,
      validatedBody.timezone
    );
    if (!household) {
      throw createHttpError(404, 'Household not found');
    }
    audit('household.settings_changed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { setting: 'timezone', value: household.timezone },
    });
    return successResponse({ timezone: household.timezone });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(validateBody(setHouseholdTimeZoneSchema));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'POST /households': createHousehold,
  'GET /households/{id}': getHousehold,
  'POST /households/{id}/invites': createInvite,
  'POST /households/{id}/invites/email': emailInvite,
  'GET /households/invites/{inviteCode}': validateInvite,
  'POST /households/join/{inviteCode}': joinHousehold,
  'GET /households/{id}/activity': getActivity,
  'GET /households/{id}/audit': getHouseholdAuditLog,
  'GET /households/{id}/analytics/daily': getDailyAnalytics,
  'GET /households/{id}/analytics/coverage': getCoverage,
  'GET /households/{id}/year-in-review': getYearInReview,
  'PUT /households/{householdId}/members/{userId}/role': updateMemberRole,
  'DELETE /households/{householdId}/members/{userId}': removeMember,
  'POST /households/{id}/leave': leaveHousehold,
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
  'PUT /households/{id}/timezone': setHouseholdTimeZone,
  // Household trash (#670) — handlers/households/trash.ts.
  'GET /households/{id}/trash': trash.listTrash,
  'POST /households/{id}/trash/{kind}/{itemId}/restore': trash.restoreTrashEntry,
  'DELETE /households/{id}/trash/{kind}/{itemId}': trash.purgeTrashEntry,
  // Caretaker seats (handlers/caretakers/management.ts) — same posture as
  // sitter links: create/list/revoke are admin-gated, the report is not.
  'POST /households/{id}/caretakers': caretakers.createCaretaker,
  'GET /households/{id}/caretakers': caretakers.listCaretakers,
  'DELETE /households/{id}/caretakers/{caretakerId}': caretakers.revokeCaretaker,
  'GET /households/{id}/caretaker-report': caretakers.getCaretakerReport,
});
