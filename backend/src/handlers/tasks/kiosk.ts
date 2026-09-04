/**
 * Kiosk PUBLIC endpoints (auth=none) — the wall display.
 *
 * A household mounts a spare tablet in the kitchen (or an office puts one in
 * the breakroom) and leaves it on `/kiosk/{token}` forever. These two routes
 * are everything that page is allowed to do: read today's tasks, and complete
 * one.
 *
 * The design rule and the full threat model live at the top of
 * `services/kioskService.ts`. The short version, because it governs every
 * line below: the token is PERMANENTLY DISPLAYED and must be assumed leaked,
 * so the surface is deliberately two operations wide, PII-free, IP-rate-
 * limited, generically 404-ing, and revocable in one click.
 *
 * Deliberately NOT here, and not to be added later: anything that reads plant
 * records, notes, member identity, household name, climate location, billing,
 * or history; and any write other than completing a task that the same token
 * could already see.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import * as kioskService from '../../services/kioskService.js';
import * as taskService from '../../services/taskService.js';
import { recordActivity } from '../../services/activity.js';
import { successResponse } from '../../utils/response.js';

/** Synthetic actor id for anything the wall display does. Traceable to the
 *  specific link, carries no person. */
const kioskActorId = (linkId: string) => `kiosk:${linkId}`;

/** How a kiosk completion reads in the household's activity feed. Naming the
 *  surface (rather than blaming a member) is what lets a household notice a
 *  leaked token: completions nobody remembers doing are labelled. */
const KIOSK_ACTOR_NAME = 'the kiosk display';

// GET /kiosk/{token}
//
// Validate the token, then return the household's due/overdue tasks for the
// kiosk horizon plus the poll interval the display should use. A generic 404
// covers every failure mode (missing / revoked / malformed) so the endpoint
// can't be used to enumerate tokens.
//
// A failure BELOW this point (a DynamoDB read that throws) propagates as a
// 5xx on purpose. The kiosk page renders that as "couldn't load"; an empty
// task array would render as "all done", and on a wall screen nobody would
// ever question it. See ADR 0010.
export const getKioskView = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const token = event.pathParameters?.token ?? '';
    const link = await kioskService.getActiveKioskLink(token);
    if (!link) {
      throw createHttpError(404, 'This kiosk link is invalid or has been turned off.');
    }
    // The sitter view's cutoff is its link's own `expiresAt` (ADR 0015). A
    // wall display has no expiry to honour — it answers "what needs doing
    // today" — so it supplies a rolling cutoff of its own instead.
    const now = new Date();
    const windowEndsAt = new Date(
      now.getTime() + kioskService.KIOSK_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const tasks = await taskService.getSitterTasks(link.householdId, windowEndsAt, now);
    return successResponse({
      pollIntervalSeconds: link.pollIntervalSeconds,
      tasks,
    });
  }
  // No authMiddleware — anonymous by design. The limit is generous enough for
  // a display polling every 60s plus a burst of completions, and tight enough
  // that the route is useless for scraping.
).use(rateLimit({ perWindowMs: 60_000, max: 60 }));

const kioskCompleteTaskSchema = z
  .object({
    // Due date from the GET view. Identifies the recurrence occurrence, so a
    // double-tap or a retried request cannot roll the schedule forward twice.
    expectedNextDue: z.string().datetime().optional(),
  })
  .nullish();
type KioskCompleteTaskInput = z.infer<typeof kioskCompleteTaskSchema>;

// POST /kiosk/{token}/tasks/{taskId}/complete
//
// Complete one task from the wall display. The token is re-validated (it may
// have been revoked since the page loaded — which is the whole remedy for a
// leaked token, so it has to bite mid-session) and the task must belong to
// THIS token's household, so a forged taskId can never reach another
// household's data.
export const completeKioskTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<KioskCompleteTaskInput>;
    const token = event.pathParameters?.token ?? '';
    const taskId = event.pathParameters?.taskId ?? '';
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }

    const link = await kioskService.getActiveKioskLink(token);
    if (!link) {
      throw createHttpError(404, 'This kiosk link is invalid or has been turned off.');
    }

    // Cross-household guard: read the task scoped to the token's household,
    // so a taskId from anywhere else simply isn't found.
    const existing = await taskService.getTask(link.householdId, taskId);
    if (!existing) {
      throw createHttpError(404, 'Task not found');
    }

    if (
      validatedBody?.expectedNextDue !== undefined &&
      existing.nextDue !== validatedBody.expectedNextDue
    ) {
      // Already completed for this occurrence (a second tap, or a retry after
      // a lost response). Acknowledge without recording a second completion.
      return successResponse({
        taskId: existing.id,
        plantName: existing.plantName,
        taskType: existing.customType || existing.type,
        dueDate: existing.nextDue,
        spaceName: null,
        placementNote: null,
        overdue: false,
      });
    }

    const task = await taskService.completeTask(
      link.householdId,
      taskId,
      kioskActorId(link.id),
      KIOSK_ACTOR_NAME,
      undefined,
      validatedBody?.expectedNextDue
    );
    if (!task) {
      // Deleted between the read above and the write — treat as not found.
      throw createHttpError(404, 'Task not found');
    }

    await recordActivity({
      type: 'task.completed',
      householdId: link.householdId,
      actorId: kioskActorId(link.id),
      actorName: KIOSK_ACTOR_NAME,
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        viaKiosk: true,
      },
    });

    // Only the PII-free shape — the same projection the sitter view uses.
    return successResponse({
      taskId: task.id,
      plantName: task.plantName,
      taskType: task.customType || task.type,
      dueDate: task.nextDue,
      spaceName: null,
      placementNote: null,
      overdue: false,
    });
  }
  // Anonymous; tighter than the read, because this is the write side.
)
  .use(rateLimit({ perWindowMs: 60_000, max: 30 }))
  .use(validateBody(kioskCompleteTaskSchema));
