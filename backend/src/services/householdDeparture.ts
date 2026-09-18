/**
 * The one departure sequence for a member leaving a household that keeps its
 * other members — shared by admin removal
 * (`DELETE /households/{householdId}/members/{userId}`) and self-leave
 * (`POST /households/{id}/leave`, #686), so the two cannot drift. Removal and
 * leaving are the same operation seen from different sides; the help page's
 * contract for one is the contract for the other.
 *
 * Order is load-bearing:
 *
 *   1. `householdService.removeMember` — the membership row and `memberCount`
 *      go first, inside the TOCTOU-safe last-admin guard (a surviving admin is
 *      pinned by a transaction ConditionCheck, so two admins leaving at once
 *      cannot both succeed). `LastAdminError` propagates to the caller before
 *      anything else has changed. It also drops the cached membership, so the
 *      departed user loses access on their next request in this container
 *      (≤60s elsewhere — docs/multi-household.md).
 *   2. `revokeCredentialsCreatedBy` — STRICTLY BEFORE step 3, which overwrites
 *      `createdBy` on exactly the rows revocation must identify (#449).
 *   3. `anonymizeUserInHousehold` — releases their tasks, prunes them from care
 *      rotations, clears space defaults and vacation windows naming them, and
 *      rewrites their history to "Former member". Returns what it changed.
 *   4. Rows in the departed user's OWN partition that are scoped to this
 *      household: the calendar-feed token (the feed already re-checks
 *      membership per fetch; deleting the row means a later re-invite does not
 *      silently revive an old URL), any household email still queued about
 *      this household (otherwise delivered by another household's hourly
 *      pass), and the native push devices registered under it (the app
 *      registers a device again, under the household they still have, when
 *      it next opens, at most six hours later).
 *   5. Cognito claims — only when this household IS their default: re-point at
 *      a remaining membership, or clear when none is left. A secondary
 *      household's departure never touches the claims.
 *
 * Removal-first is deliberate. If a later step fails, the person is already
 * out (the safe direction) and the caller returns a 500; the reverse order
 * would risk anonymising the record of someone the last-admin guard then kept
 * in the household.
 *
 * Billing is never touched here: subscriptions belong to households, not
 * people, and a household that keeps members keeps its plan
 * (docs/multi-household.md). The leave route's billing acknowledgement is a
 * question asked BEFORE this runs, not an action taken by it.
 */
import * as householdService from './householdService.js';
import * as accountCleanup from './accountCleanup.js';
import * as calendarTokens from './calendarTokens.js';
import * as deviceTokens from './deviceTokens.js';
import * as householdEmails from './householdEmails.js';
import * as cognitoUsers from './cognitoUsers.js';

export interface DepartureResult {
  revokedCredentials: accountCleanup.RevokedCredentialCounts;
  cleanup: accountCleanup.DepartureCleanupSummary;
  /** Pending household emails about this household dropped from the
   *  departed user's own queue. */
  droppedQueuedEmails: number;
  /**
   * The user's default (Cognito-claim) household after the departure: the
   * same one when this was a secondary household, a remaining membership when
   * this was the default, or null when they now belong to none.
   */
  defaultHouseholdId: string | null;
  /** The caller's role in `defaultHouseholdId`, from the same source that set
   *  the claim; null exactly when `defaultHouseholdId` is. */
  defaultHouseholdRole: 'admin' | 'member' | null;
}

export async function departHousehold(
  householdId: string,
  userId: string
): Promise<DepartureResult> {
  await householdService.removeMember(householdId, userId);

  const revokedCredentials = await accountCleanup.revokeCredentialsCreatedBy(householdId, userId);
  const cleanup = await accountCleanup.anonymizeUserInHousehold(householdId, userId);

  await calendarTokens.revokeCalendarToken(userId, householdId);
  const droppedQueuedEmails = await householdEmails.discardQueuedForHousehold(userId, householdId);
  await deviceTokens.deleteDeviceTokensForHousehold(userId, householdId);

  // Same claims hygiene removal has always done, and the same reads: the
  // membership list is only consulted when the default has to move.
  const claims = await cognitoUsers.getHouseholdClaims(userId);
  let defaultHouseholdId = claims.householdId;
  let defaultHouseholdRole = claims.householdId ? claims.role : null;
  if (claims.householdId === householdId) {
    const remaining = await householdService.getMembershipsByUser(userId);
    const next = remaining.find((m) => m.householdId !== householdId);
    if (next) {
      await cognitoUsers.setHouseholdClaims(userId, next.householdId, next.role);
      defaultHouseholdId = next.householdId;
      defaultHouseholdRole = next.role;
    } else {
      await cognitoUsers.clearHouseholdClaims(userId);
      defaultHouseholdId = null;
      defaultHouseholdRole = null;
    }
  }

  return {
    revokedCredentials,
    cleanup,
    droppedQueuedEmails,
    defaultHouseholdId,
    defaultHouseholdRole,
  };
}
