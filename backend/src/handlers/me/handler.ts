import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import * as householdService from '../../services/householdService.js';
import * as plantService from '../../services/plantService.js';
import * as cognitoUsers from '../../services/cognitoUsers.js';
import * as taskService from '../../services/taskService.js';
import * as notificationPrefs from '../../services/notificationPrefs.js';
import * as apiKeys from '../../services/apiKeys.js';
import * as accountCleanup from '../../services/accountCleanup.js';
import * as calendarTokens from '../../services/calendarTokens.js';
import * as billingEmails from '../../services/billingEmails.js';
import { buildIcs } from '../../services/icsExport.js';
import { myToday } from './today.js';
import { createdResponse, noContentResponse, successResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

/**
 * Refuse the deletion if the user is the last admin in a household with
 * other members. Without this guardrail the household would be locked
 * out — invites can't be issued and roles can't be changed without an
 * admin. Callers must promote someone else first.
 */
function refuseIfOnlyAdmin(
  userId: string,
  role: 'admin' | 'member',
  members: { userId: string; role: 'admin' | 'member' }[]
): void {
  if (role !== 'admin') return;
  const admins = members.filter((m) => m.role === 'admin');
  const isLoneAdmin = admins.length === 1 && admins[0].userId === userId;
  if (isLoneAdmin && members.length > 1) {
    throw createHttpError(400, 'Promote another member to admin before deleting your account');
  }
}

/**
 * If the caller is the only member of their household, the plants in it
 * are about to be orphaned — wipe them as part of the delete. We rely on
 * `plantService.deletePlant` to cascade task + photo cleanup.
 */
async function wipeSoloHouseholdPlants(householdId: string, members: unknown[]): Promise<void> {
  if (members.length !== 1) return;
  const plants = await plantService.getPlants(householdId, 'all');
  for (const p of plants) {
    await plantService.deletePlant(householdId, p.id);
  }
}

// DELETE /me
// Self-service account deletion (GDPR right to erasure). The flow, across
// EVERY household the user is a member of (not just the active claim one):
//   1. If the user is the lone admin of any multi-member household, refuse
//      (consistent with the long-standing single-household guard).
//   2. Cancel the Stripe subscription of every household they are the ONLY
//      member of. Subscriptions are per household, so leaving a household
//      that keeps other members never touches billing — but an abandoned
//      household is erased below together with the only login that could
//      reach the billing portal, so its subscription must die first. This
//      runs before ANY destructive step and fails closed: if Stripe cannot
//      confirm the subscription is dead, the deletion is refused (502) with
//      nothing touched, and a retry is safe (see
//      accountCleanup.cancelAbandonedHouseholdSubscription).
//   3. For households where they're the only member, wipe plants (cascading
//      task/photo cleanup) and revoke the household's API keys — the
//      household is being abandoned.
//   4. Anonymize their identity in retained shared history and clear active
//      task assignments, then remove their member row from each household.
//   5. Delete the complete user-scoped partition: notification prefs, phone
//      challenges, browser/native credentials, and every delivery marker.
//   6. Delete their Cognito user.
// Shared completion/activity facts remain useful to the household, but the
// deleted user's display name and stable id do not.
export const deleteMe = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;

    const memberships = await householdService.getMembershipsByUser(user.userId);

    // Guard pass FIRST: refuse before any destructive work so a rejection
    // can't leave the account half-deleted.
    const membersByHousehold = new Map<
      string,
      Awaited<ReturnType<typeof householdService.getHouseholdMembers>>
    >();
    for (const m of memberships) {
      const members = await householdService.getHouseholdMembers(m.householdId);
      membersByHousehold.set(m.householdId, members);
      refuseIfOnlyAdmin(user.userId, m.role, members);
    }

    // Billing pass: cancel the subscription of every household about to be
    // abandoned, BEFORE the destructive pass. A failure here refuses the
    // whole deletion with nothing deleted — the alternative is a user who can
    // no longer log in but is still being charged, with no self-serve way out.
    for (const m of memberships) {
      const members = membersByHousehold.get(m.householdId) ?? [];
      if (members.length !== 1) continue;
      let cancellation: accountCleanup.SubscriptionCancellationOutcome;
      try {
        cancellation = await accountCleanup.cancelAbandonedHouseholdSubscription(m.householdId);
      } catch (err) {
        logger.error(
          { err, householdId: m.householdId },
          'account_deletion_refused_subscription_cancel_failed'
        );
        throw createHttpError(
          502,
          "We couldn't cancel your household's subscription, so your account was not deleted. Please try again in a few minutes.",
          { expose: true }
        );
      }
      if (cancellation.outcome !== 'no_subscription') {
        audit('billing.subscription_changed', {
          actorId: user.userId,
          actorEmail: user.email,
          householdId: m.householdId,
          metadata: {
            trigger: 'account_deletion',
            outcome: cancellation.outcome,
            subscriptionId: cancellation.subscriptionId,
          },
        });
      }
    }

    // Destructive pass. The two counters are what the confirmation email
    // reports; they are counted from the work actually done, never estimated.
    let soleMemberHouseholds = 0;
    let sharedHouseholds = 0;
    for (const m of memberships) {
      const members = membersByHousehold.get(m.householdId) ?? [];
      if (members.length === 1) {
        soleMemberHouseholds += 1;
        // Sole member: the household is being abandoned. Cascade-delete its
        // plants and revoke its API keys so no orphaned credential keeps
        // reading the dead household's data.
        await wipeSoloHouseholdPlants(m.householdId, members);
        const keys = await apiKeys.listApiKeys(m.householdId);
        for (const key of keys) {
          await apiKeys.revokeApiKey(m.householdId, key.id);
        }
        // Remove household metadata, spaces, residual task/chat rows,
        // activity, and every sitter credential. The sole member row is part
        // of this generic partition sweep, so there is nothing left for
        // removeMember to decrement.
        await accountCleanup.deleteAbandonedHouseholdData(m.householdId);
        continue;
      }
      sharedHouseholds += 1;
      await accountCleanup.anonymizeUserInHousehold(m.householdId, user.userId);
      await householdService.removeMember(m.householdId, user.userId);
    }

    await accountCleanup.deleteUserScopedData(user.userId);

    await cognitoUsers.deleteUser(user.userId);

    // Confirmation, sent only once every destructive step has succeeded — a
    // failure above throws before this line, so the email can never promise a
    // deletion that did not happen. It states what was retained (shared care
    // history under a pseudonym, Stripe's own payment records, database
    // backups within their retention window) as plainly as what was removed:
    // `docs/compliance.md` §3 requires disclosing the pseudonymization caveat,
    // and this is the moment a person is actually reading. Best-effort — the
    // account is already gone and refusing to confirm it would not bring it
    // back (ADR 0023).
    const emailDelivered = await billingEmails.sendAccountDeletionEmail({
      email: user.email,
      soleMemberHouseholds,
      sharedHouseholds,
    });

    audit('auth.account_deleted', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: user.householdId ?? undefined,
      metadata: {
        householdsCleaned: memberships.map((m) => m.householdId),
        // `false` covers both a failed send and an unconfigured sender. It is
        // recorded rather than smoothed over: "we told them" is a compliance
        // claim, and it must not be made on a delivery that did not happen.
        confirmationEmailDelivered: emailDelivered,
      },
    });

    return noContentResponse();
  }
).use(authMiddleware());

// GET /me/export
// GDPR-style "right to data portability" export. Returns, as a downloadable
// JSON document, the personal data we hold for the caller: their profile,
// notification preferences, household memberships, and — for each household
// they belong to — the plants and tasks they have access to. We deliberately
// don't fan out to other members' personal data; past completion records keep
// contributor names as historical artifacts (same policy as DELETE /me).
// Paired with DELETE /me, this satisfies the access + erasure obligations.
export const exportMe = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;

    const [name, preferences, memberships] = await Promise.all([
      cognitoUsers.getUserName(user.userId, user.email),
      notificationPrefs.getPreferences(user.userId),
      householdService.getMembershipsByUser(user.userId),
    ]);

    const households = await Promise.all(
      memberships.map(async (m) => {
        const [household, plants, tasks] = await Promise.all([
          householdService.getHousehold(m.householdId),
          // 'all' — the export promises every plant; getPlants defaults to
          // 'active' only, which would silently drop died/gave-away plants.
          plantService.getPlants(m.householdId, 'all'),
          taskService.getTasks(m.householdId),
        ]);
        return {
          id: m.householdId,
          name: household?.name ?? '',
          role: m.role,
          joinedAt: m.joinedAt,
          plants,
          tasks,
        };
      })
    );

    const payload = {
      format: 'family-greenhouse-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      user: { id: user.userId, email: user.email, name },
      notificationPreferences: preferences,
      households,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="family-greenhouse-export.json"',
        // A data export is personal and point-in-time; never let a shared
        // cache hold it.
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(payload, null, 2),
    };
  }
).use(authMiddleware());

// GET /me/households
// All households the caller is a member of, regardless of which one is
// currently the "active" household pinned by the X-Household-Id header.
// Frontend uses this to render the household-switcher.
export const listMyHouseholds = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const memberships = await householdService.getMembershipsByUser(user.userId);
    // Hydrate household names so the switcher doesn't need a second roundtrip.
    const detailed = await Promise.all(
      memberships.map(async (m) => {
        const h = await householdService.getHousehold(m.householdId);
        return {
          householdId: m.householdId,
          name: h?.name ?? '',
          role: m.role,
          joinedAt: m.joinedAt,
        };
      })
    );
    return successResponse(detailed);
  }
).use(authMiddleware());

/** Shared response shape for both ICS routes (authed download + public feed). */
function icsResponse(ics: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="family-greenhouse.ics"',
      // Calendar clients refetch on their own schedule; a 5-minute
      // browser hint keeps fast re-loads from the same client cheap
      // without delaying real updates noticeably.
      'Cache-Control': 'private, max-age=300',
    },
    body: ics,
  };
}

// GET /me/calendar.ics
// AUTHENTICATED one-shot download of the caller's active-household tasks as
// iCalendar. This route sits behind the API Gateway JWT authorizer, so it
// works from the app (bearer token attached) but NOT as a calendar-app
// subscription URL: Apple/Google/Outlook fetch subscriptions with no session
// and were getting 401 from the gateway. The subscribe-able feed is
// GET /calendar/{token}/family-greenhouse.ics below.
export const calendarIcs = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (!user.householdId) {
      // 403 (not 400): the request is well-formed; the caller's identity
      // simply lacks a household — matches the requireHousehold convention.
      throw createHttpError(403, 'No household selected');
    }
    const tasks = await taskService.getTasks(user.householdId);
    const hemisphere = await taskService.hemisphereForTasks(user.householdId, tasks);
    return icsResponse(buildIcs(tasks, new Date(), hemisphere));
  }
).use(authMiddleware());

// ---------------------------------------------------------------------------
// Calendar-feed link: a per-user, per-household capability URL
// ---------------------------------------------------------------------------
//
// The tradeoff, stated plainly: the feed URL carries its own credential (a
// 256-bit token in the path) because calendar apps cannot carry a Cognito
// session, so anyone holding the URL can read the feed. What bounds that:
//   - the token is scoped to ONE user's view of ONE household, read-only, and
//     the feed emits only task titles, cadence, and due dates (never notes,
//     assignees, or member data — see services/icsExport.ts);
//   - it is stored hashed, returned once, revocable, and regenerable from
//     Settings (services/calendarTokens.ts);
//   - membership is re-validated on every fetch, so a removed member's URL
//     dies with their membership;
//   - the public route is IP-rate-limited, and the log line never carries the
//     path secret (middleware/logging.ts).
// It is NOT an API key and grants nothing under /api/v1 or any authed route.

/** Non-secret status projection — never includes the token. */
function calendarTokenStatus(record: calendarTokens.CalendarTokenRecord | null) {
  return {
    active: record !== null,
    createdAt: record?.createdAt ?? null,
    lastUsedAt: record?.lastUsedAt ?? null,
  };
}

// One generic message for every miss (unknown / revoked / regenerated /
// membership gone): the public endpoint must not be a token-existence oracle,
// and a 401 would make Apple Calendar prompt for a password that doesn't
// exist — 404 makes a dead subscription simply fail.
const CALENDAR_LINK_INVALID = 'This calendar link is invalid or has been revoked.';

// GET /me/calendar-token
// Whether the caller has a feed link for the ACTIVE household (X-Household-Id
// aware, like every household-scoped route). Never returns the token — it
// isn't stored in a readable form. Regenerate is the recovery path.
export const getCalendarToken = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const record = await calendarTokens.getCalendarToken(user.userId, user.householdId!);
    return successResponse(calendarTokenStatus(record));
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /me/calendar-token
// Mint the caller's feed link for the active household, replacing any
// existing one (this is also "regenerate"). The token leaves the building
// exactly once, here, alongside the path the frontend composes into the
// full URL. Any member may hold a feed of what they can already see — no
// admin gate, unlike API keys, which grant programmatic access to the
// whole household. Per-user rate-limited: nothing legitimate regenerates a
// calendar link ten times a minute.
export const createCalendarToken = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const result = await calendarTokens.createCalendarToken(user.userId, user.householdId!);
    // Audit carries identity only — never the token.
    audit('calendar_token.created', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: user.householdId ?? undefined,
    });
    return createdResponse({
      ...calendarTokenStatus(result.record),
      token: result.token,
      path: calendarTokens.calendarFeedPath(result.token),
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }));

// DELETE /me/calendar-token
// Revoke the caller's feed link for the active household. 404 when there is
// none — a 204 for a link that never existed would make "did I actually
// revoke it?" unanswerable (same convention as API keys).
export const revokeCalendarToken = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const revoked = await calendarTokens.revokeCalendarToken(user.userId, user.householdId!);
    if (!revoked) {
      throw createHttpError(404, 'No calendar link to revoke');
    }
    audit('calendar_token.revoked', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: user.householdId ?? undefined,
    });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// GET /calendar/{token}/family-greenhouse.ics
// PUBLIC (auth=none) subscribe-able iCalendar feed. Reachable WITHOUT a
// Cognito JWT — the token in the path is the only credential, and it is
// validated on every fetch. No authMiddleware; 60/min per IP absorbs a
// calendar client's refresh storms while keeping brute force pointless
// against a 256-bit token.
export const calendarFeed = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const token = event.pathParameters?.token ?? '';
    const grant = await calendarTokens.resolveCalendarToken(token);
    if (!grant) {
      throw createHttpError(404, CALENDAR_LINK_INVALID);
    }
    // The membership row is authoritative (same rule as authMiddleware): a
    // user who left, or was removed from, the household loses the feed even
    // though their token row still exists.
    const member = await householdService.getMemberByUserId(grant.householdId, grant.userId);
    if (!member) {
      throw createHttpError(404, CALENDAR_LINK_INVALID);
    }
    // Scoped by the grant, never by anything the request carries: a token
    // for household A cannot be pointed at household B.
    const tasks = await taskService.getTasks(grant.householdId);
    const hemisphere = await taskService.hemisphereForTasks(grant.householdId, tasks);
    return icsResponse(buildIcs(tasks, new Date(), hemisphere));
  }
).use(rateLimit({ perWindowMs: 60_000, max: 60 }));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'DELETE /me': deleteMe,
  'GET /me/export': exportMe,
  'GET /me/households': listMyHouseholds,
  'GET /me/today': myToday,
  'GET /me/calendar.ics': calendarIcs,
  'GET /me/calendar-token': getCalendarToken,
  'POST /me/calendar-token': createCalendarToken,
  'DELETE /me/calendar-token': revokeCalendarToken,
  'GET /calendar/{token}/family-greenhouse.ics': calendarFeed,
});
