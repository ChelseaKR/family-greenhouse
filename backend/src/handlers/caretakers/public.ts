/**
 * Caretaker seats — the public, token-scoped surface (auth=none).
 *
 * Dispatched by the `tasks` Lambda group, exactly like the public sitter
 * routes, because these read and complete tasks. The 256-bit token in the
 * path is the only credential; there is no account, no sign-in, and no
 * Cognito user behind a caretaker.
 *
 * The permission surface is `caretakerService.CARETAKER_PERMISSIONS` and
 * nothing else: complete a task, add a note, add a photo (the photo routes
 * live in `./photos.ts`, in the plants group that owns the image pipeline).
 * There is deliberately no route here that edits a plant, sees members, sees
 * other caretakers, reads the activity feed, or touches billing or settings.
 *
 * Every action is attributed to the caretaker's NAME — that is the difference
 * between this and a sitter link, whose completions read "a plant sitter" —
 * and every action is folded into a visit record so the household can produce
 * a dated account of what was done (see caretakerService).
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import {
  caretakerCompleteTaskSchema,
  CaretakerCompleteTaskInput,
  caretakerNoteSchema,
  CaretakerNoteInput,
} from '../../models/caretakerSchemas.js';
import * as caretakerService from '../../services/caretakerService.js';
import * as taskService from '../../services/taskService.js';
import { recordActivity } from '../../services/activity.js';
import { successResponse } from '../../utils/response.js';
import { lookaheadDays, requireActiveCaretaker, recordVisitAction } from './shared.js';

// GET /caretaker/{token}
//
// The caretaker's worklist. Same PII-free projection as the sitter view (no
// member identity, no private notes, no household climate location; current
// space and placement note ARE shared, as care directions), plus the
// caretaker's own name so the page can greet them by it and be explicit about
// what their actions will be attributed to.
export const getCaretakerView = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const caretaker = await requireActiveCaretaker(event);
    const now = new Date();
    const tasks = await taskService.getCaretakerTasks(
      caretaker.householdId,
      now,
      lookaheadDays(caretaker.expiresAt, now)
    );
    return successResponse({
      caretakerName: caretaker.name,
      startsAt: caretaker.startsAt,
      expiresAt: caretaker.expiresAt,
      permissions: caretakerService.CARETAKER_PERMISSIONS,
      tasks,
    });
  }
  // Anonymous. 60/min per IP absorbs a page load plus a few actions while
  // blunting token scraping.
).use(rateLimit({ perWindowMs: 60_000, max: 60 }));

// POST /caretaker/{token}/tasks/{taskId}/complete
//
// Complete one task, attributed to the caretaker by name. The token is
// re-validated (it may have been revoked since the page loaded) and the task
// must belong to THIS token's household, so a forged taskId cannot reach
// another partition.
export const completeCaretakerTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<CaretakerCompleteTaskInput>;
    const taskId = event.pathParameters?.taskId ?? '';
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }
    const caretaker = await requireActiveCaretaker(event);

    const existing = await taskService.getTask(caretaker.householdId, taskId);
    if (!existing) {
      throw createHttpError(404, 'Task not found');
    }

    if (
      validatedBody?.expectedNextDue !== undefined &&
      existing.nextDue !== validatedBody.expectedNextDue
    ) {
      // This occurrence was already completed (a retried request). Acknowledge
      // without a second completion, activity row, or visit line.
      return successResponse({
        taskId: existing.id,
        plantName: existing.plantName,
        taskType: existing.customType || existing.type,
        dueDate: existing.nextDue,
        overdue: false,
        visitRecorded: true,
      });
    }

    const actorId = `caretaker:${caretaker.id}`;
    const task = await taskService.completeTask(
      caretaker.householdId,
      taskId,
      actorId,
      caretaker.name,
      undefined,
      validatedBody?.expectedNextDue
    );
    if (!task) {
      // Deleted between the read above and the write — treat as not found.
      throw createHttpError(404, 'Task not found');
    }

    const taskType = task.customType || task.type;
    const visitRecorded = await recordVisitAction(caretaker, {
      kind: 'task',
      entry: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType,
        at: new Date().toISOString(),
      },
    });

    await recordActivity({
      type: 'task.completed',
      householdId: caretaker.householdId,
      actorId,
      actorName: caretaker.name,
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType,
        viaCaretaker: true,
      },
    });

    return successResponse({
      taskId: task.id,
      plantName: task.plantName,
      taskType,
      dueDate: task.nextDue,
      overdue: false,
      visitRecorded,
    });
  }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 30 }))
  .use(validateBody(caretakerCompleteTaskSchema));

// POST /caretaker/{token}/notes
//
// Leave a note on the visit ("the fern by the window looks unhappy"). The note
// IS the record here, so unlike a task completion a failed visit write is
// fatal: the caretaker is told it did not save rather than being shown a
// success for something nobody will ever read.
export const addCaretakerNote = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<CaretakerNoteInput>;
    const caretaker = await requireActiveCaretaker(event);
    const at = new Date().toISOString();

    await caretakerService.recordCaretakerAction(caretaker, {
      kind: 'note',
      entry: { text: validatedBody.text, at },
    });

    await recordActivity({
      type: 'caretaker.note',
      householdId: caretaker.householdId,
      actorId: `caretaker:${caretaker.id}`,
      actorName: caretaker.name,
      payload: { text: validatedBody.text },
    });

    return successResponse({ text: validatedBody.text, at, visitRecorded: true });
  }
)
  .use(rateLimit({ perWindowMs: 60_000, max: 20 }))
  .use(validateBody(caretakerNoteSchema));
