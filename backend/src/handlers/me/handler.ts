import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent } from '../../middleware/auth.js';
import * as householdService from '../../services/householdService.js';
import * as plantService from '../../services/plantService.js';
import * as cognitoUsers from '../../services/cognitoUsers.js';
import * as taskService from '../../services/taskService.js';
import * as notificationPrefs from '../../services/notificationPrefs.js';
import { buildIcs } from '../../services/icsExport.js';
import { noContentResponse, successResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';

/**
 * Refuse the deletion if the caller is the last admin in a household with
 * other members. Without this guardrail the household would be locked
 * out — invites can't be issued and roles can't be changed without an
 * admin. Callers must promote someone else first.
 */
function refuseIfOnlyAdmin(
  user: AuthenticatedEvent['user'],
  members: { userId: string; role: 'admin' | 'member' }[]
): void {
  if (user.householdRole !== 'admin') return;
  const admins = members.filter((m) => m.role === 'admin');
  const isLoneAdmin = admins.length === 1 && admins[0].userId === user.userId;
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
  const plants = await plantService.getPlants(householdId);
  for (const p of plants) {
    await plantService.deletePlant(householdId, p.id);
  }
}

// DELETE /me
// Self-service account deletion. The flow is:
//   1. If the user is the lone admin of a multi-member household, refuse.
//   2. If they're the only member, wipe their plants (cascading).
//   3. Remove their household-member row.
//   4. Delete their Cognito user.
// We deliberately don't anonymize past completions — those still belong to the
// household's history. The user's display name on those rows becomes a
// historical artifact.
export const deleteMe = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;

    if (user.householdId) {
      const members = await householdService.getHouseholdMembers(user.householdId);
      refuseIfOnlyAdmin(user, members);
      await wipeSoloHouseholdPlants(user.householdId, members);
      await householdService.removeMember(user.householdId, user.userId);
    }

    await cognitoUsers.deleteUser(user.userId);

    audit('auth.account_deleted', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: user.householdId ?? undefined,
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
          plantService.getPlants(m.householdId),
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

// GET /me/calendar.ics
// Subscribe-able iCalendar feed for the caller's active household tasks.
// Calendar apps re-fetch periodically; the embedded RRULE drives
// recurrence locally, so we only emit one VEVENT per task.
export const calendarIcs = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (!user.householdId) {
      throw createHttpError(400, 'No household selected');
    }
    const tasks = await taskService.getTasks(user.householdId);
    const ics = buildIcs(tasks);
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
).use(authMiddleware());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'DELETE /me': deleteMe,
  'GET /me/export': exportMe,
  'GET /me/households': listMyHouseholds,
  'GET /me/calendar.ics': calendarIcs,
});
