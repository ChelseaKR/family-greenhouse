/**
 * Household trash management (#670): list, restore, delete now.
 *
 * `DELETE /plants/{id}` and `DELETE /tasks/{id}` move items INTO the trash
 * (services/trashService.ts has the storage design and why it fails closed);
 * these three routes are the way back out, or the way on to permanent.
 *
 * Open to every member, with no plan gate: deleting a plant or a task has
 * never been admin-only or paid, and the undo for it must not be either.
 * A household where anyone can delete by mistake is exactly the household
 * that needs anyone to be able to put it back. The one plan interaction is
 * the plant cap — restoring an ACTIVE plant is adding a plant, so it is
 * refused with the same 402 and the same words `POST /plants` uses.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import * as trashService from '../../services/trashService.js';
import * as billing from '../../services/billing.js';
import * as activity from '../../services/activity.js';
import * as householdService from '../../services/householdService.js';
import * as householdAudit from '../../services/householdAudit.js';
import { getEntitledPlan, limitOf } from '../../models/plans.js';
import { successResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

function householdFrom(event: APIGatewayProxyEvent): string {
  const { user } = event as AuthenticatedEvent;
  const householdId = event.pathParameters?.id;
  if (!householdId) {
    throw createHttpError(400, 'Household ID is required');
  }
  // Same guard every households route carries: the caller's resolved
  // household (membership-checked by authMiddleware) must be the one named.
  if (user.householdId !== householdId) {
    throw createHttpError(403, 'Access denied');
  }
  return householdId;
}

function entryFrom(event: APIGatewayProxyEvent): {
  kind: trashService.TrashKind;
  itemId: string;
} {
  const kind = event.pathParameters?.kind;
  const itemId = event.pathParameters?.itemId;
  if (!trashService.isTrashKind(kind)) {
    throw createHttpError(400, 'Trash kind must be "plant" or "task"');
  }
  if (!itemId) {
    throw createHttpError(400, 'Item ID is required');
  }
  return { kind, itemId };
}

/**
 * The caller's display name, read BEFORE anything is written: a failed read
 * fails the request with nothing changed, rather than being papered over
 * with a placeholder name after the fact (ADR 0010). The membership row is
 * the one `authMiddleware` just validated, so a missing row is not expected;
 * the fallback covers a legacy row with an empty name.
 */
async function actorName(householdId: string, userId: string): Promise<string> {
  const member = await householdService.getMemberByUserId(householdId, userId);
  return member?.name || 'Someone';
}

// GET /households/:id/trash
export const listTrash = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const householdId = householdFrom(event);
    const entries = await trashService.listTrash(householdId);
    return successResponse({ retentionDays: trashService.TRASH_RETENTION_DAYS, entries });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /households/:id/trash/:kind/:itemId/restore
export const restoreTrashEntry = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = householdFrom(event);
    const { kind, itemId } = entryFrom(event);

    // Caps follow ENTITLEMENT, not the plan row (#476) — the same read
    // POST /plants makes before adding a plant.
    const plan = getEntitledPlan(await billing.getHouseholdSubscription(householdId));
    const actor = await actorName(householdId, user.userId);

    let restored: trashService.TrashEntrySummary;
    try {
      restored = await trashService.restoreEntry(householdId, kind, itemId, {
        maxPlants: limitOf(plan, 'plants'),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'PlanLimitError') {
        throw createHttpError(
          402,
          `Your ${plan.name} plan is limited to ${limitOf(plan, 'plants')} plants. Remove or archive a plant before adding more.`
        );
      }
      if (name === 'TrashEntryNotFoundError') throw createHttpError(404, (err as Error).message);
      if (name === 'TrashEntryExpiredError') throw createHttpError(410, (err as Error).message);
      if (name === 'TrashRestoreBlockedError' || name === 'TrashConflictError') {
        throw createHttpError(409, (err as Error).message);
      }
      throw err;
    }

    audit('trash.restored', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: itemId,
      householdId,
      metadata: { kind },
    });
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'trash.restored',
      actor: { type: 'member', userId: user.userId },
      details: { itemKind: kind, itemId },
    });

    if (kind === 'plant') {
      activity
        .recordActivity({
          type: 'plant.restored',
          householdId,
          actorId: user.userId,
          actorName: actor,
          payload: { plantId: itemId, plantName: restored.name, fromTrash: true },
        })
        .catch((err) => {
          logger.warn({ err }, 'activity_record_failed');
        });
    }

    return successResponse(restored);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());

// DELETE /households/:id/trash/:kind/:itemId
//
// "Delete now": permanent, ahead of the 30 days. The same purge the daily
// job runs, so a throttled batch is retried and a partial failure leaves the
// entry in place for the next attempt rather than half-deleted and unlisted.
export const purgeTrashEntry = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = householdFrom(event);
    const { kind, itemId } = entryFrom(event);

    const entry = await trashService.getEntry(householdId, kind, itemId);
    if (!entry) {
      throw createHttpError(404, 'That item is not in the trash');
    }
    const actor = await actorName(householdId, user.userId);

    let counts: trashService.PurgeCounts | null;
    try {
      counts = await trashService.purgeEntry(householdId, kind, itemId);
    } catch (err) {
      if (err instanceof Error && err.name === 'TrashConflictError') {
        throw createHttpError(409, err.message);
      }
      throw err;
    }
    if (!counts) {
      throw createHttpError(404, 'That item is not in the trash');
    }

    audit(kind === 'plant' ? 'plant.deleted' : 'trash.purged', {
      actorId: user.userId,
      actorEmail: user.email,
      targetId: itemId,
      householdId,
      metadata: { kind, trigger: 'delete_now', ...counts },
    });
    await householdAudit.recordHouseholdAudit({
      householdId,
      kind: 'trash.purged',
      actor: { type: 'member', userId: user.userId },
      details: { itemKind: kind, itemId },
    });

    if (kind === 'plant') {
      activity
        .recordActivity({
          type: 'plant.deleted',
          householdId,
          actorId: user.userId,
          actorName: actor,
          payload: { plantId: itemId, plantName: entry.name },
        })
        .catch((err) => {
          logger.warn({ err }, 'activity_record_failed');
        });
    }

    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());
