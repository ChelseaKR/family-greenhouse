import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent } from '../../middleware/auth.js';
import * as householdService from '../../services/householdService.js';
import * as plantService from '../../services/plantService.js';
import * as cognitoUsers from '../../services/cognitoUsers.js';
import * as taskService from '../../services/taskService.js';
import * as notificationPrefs from '../../services/notificationPrefs.js';
import * as pushSubscriptions from '../../services/pushSubscriptions.js';
import * as deviceTokens from '../../services/deviceTokens.js';
import * as apiKeys from '../../services/apiKeys.js';
import * as accountCleanup from '../../services/accountCleanup.js';
import { dynamodb, TABLE_NAME } from '../../utils/dynamodb.js';
import { buildIcs } from '../../services/icsExport.js';
import { noContentResponse, successResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';

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
  const plants = await plantService.getPlants(householdId);
  for (const p of plants) {
    await plantService.deletePlant(householdId, p.id);
  }
}

// DELETE /me
// Self-service account deletion (GDPR right to erasure). The flow, across
// EVERY household the user is a member of (not just the active claim one):
//   1. If the user is the lone admin of any multi-member household, refuse
//      (consistent with the long-standing single-household guard).
//   2. For households where they're the only member, wipe plants (cascading
//      task/photo cleanup) and revoke the household's API keys — the
//      household is being abandoned.
//   3. Anonymize their identity in retained shared history and clear active
//      task assignments, then remove their member row from each household.
//   4. Delete user-scoped rows: notification prefs, browser subscriptions,
//      and native APNs/FCM device tokens.
//   5. Delete their Cognito user.
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

    // Destructive pass.
    for (const m of memberships) {
      const members = membersByHousehold.get(m.householdId) ?? [];
      if (members.length === 1) {
        // Sole member: the household is being abandoned. Cascade-delete its
        // plants and revoke its API keys so no orphaned credential keeps
        // reading the dead household's data.
        await wipeSoloHouseholdPlants(m.householdId, members);
        const keys = await apiKeys.listApiKeys(m.householdId);
        for (const key of keys) {
          await apiKeys.revokeApiKey(m.householdId, key.id);
        }
      }
      await accountCleanup.anonymizeUserInHousehold(m.householdId, user.userId);
      await householdService.removeMember(m.householdId, user.userId);
    }

    // User-scoped personal data. Push subscriptions go through the service's
    // existing exports; notification prefs have no delete export (module is
    // owned elsewhere), so delete the row inline with its documented key
    // shape USER#{id}/PREFS.
    const subs = await pushSubscriptions.getUserSubscriptions(user.userId);
    for (const sub of subs) {
      await pushSubscriptions.deleteSubscription(user.userId, sub.endpoint);
    }
    await deviceTokens.deleteUserDeviceTokens(user.userId);
    await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${user.userId}`, SK: 'PREFS' },
      })
    );

    await cognitoUsers.deleteUser(user.userId);

    audit('auth.account_deleted', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId: user.householdId ?? undefined,
      metadata: { householdsCleaned: memberships.map((m) => m.householdId) },
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

// GET /me/calendar.ics
// Subscribe-able iCalendar feed for the caller's active household tasks.
// Calendar apps re-fetch periodically; the embedded RRULE drives
// recurrence locally, so we only emit one VEVENT per task.
export const calendarIcs = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    if (!user.householdId) {
      // 403 (not 400): the request is well-formed; the caller's identity
      // simply lacks a household — matches the requireHousehold convention.
      throw createHttpError(403, 'No household selected');
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
