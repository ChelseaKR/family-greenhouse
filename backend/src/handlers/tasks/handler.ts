import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import {
  createTaskSchema,
  updateTaskSchema,
  snoozeTaskSchema,
  completeTaskSchema,
  applyTemplateSchema,
  applyTemplateBulkSchema,
  setVacationSchema,
  CreateTaskInput,
  UpdateTaskInput,
  SnoozeTaskInput,
  CompleteTaskInput,
  ApplyTemplateInput,
  ApplyTemplateBulkInput,
  SetVacationInput,
  TaskFilters,
} from '../../models/schemas.js';
import * as taskService from '../../services/taskService.js';
import * as plantService from '../../services/plantService.js';
import * as householdService from '../../services/householdService.js';
import { recordActivity } from '../../services/activity.js';
import {
  successResponse,
  createdResponse,
  noContentResponse,
  cacheableResponse,
} from '../../utils/response.js';

// GET /tasks
export const listTasks = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;

    const filters: TaskFilters = {};
    const query = event.queryStringParameters || {};

    if (query.plantId) {
      filters.plantId = query.plantId;
    }
    if (query.assignedTo) {
      filters.assignedTo = query.assignedTo;
    }
    if (query.dueWithin) {
      // parseInt's NaN used to flow into the date filter and silently return
      // an empty list; reject non-numeric input explicitly instead.
      const days = Number(query.dueWithin);
      if (!Number.isInteger(days) || days < 0) {
        throw createHttpError(400, 'dueWithin must be a non-negative integer');
      }
      filters.dueWithin = days;
    }
    if (query.overdue === 'true') {
      filters.overdue = true;
    }

    const tasks = await taskService.getTasks(user.householdId!, filters);

    return successResponse(tasks);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// GET /tasks/upcoming
export const getUpcomingTasks = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;

    const tasks = await taskService.getUpcomingTasks(user.householdId!);

    return successResponse(tasks);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /tasks
export const createTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CreateTaskInput>;

    // Verify plant exists and belongs to household
    const plant = await plantService.getPlant(user.householdId!, validatedBody.plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }

    const task = await taskService.createTask(
      validatedBody,
      user.householdId!,
      user.userId,
      plant.name
    );

    return createdResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(createTaskSchema));

// GET /tasks/:id
export const getTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const taskId = event.pathParameters?.id;

    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }

    const task = await taskService.getTask(user.householdId!, taskId);

    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// PUT /tasks/:id
export const updateTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<UpdateTaskInput>;
    const taskId = event.pathParameters?.id;

    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }

    const task = await taskService.updateTask(user.householdId!, taskId, validatedBody);

    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(updateTaskSchema));

// DELETE /tasks/:id
export const deleteTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const taskId = event.pathParameters?.id;

    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }

    const deleted = await taskService.deleteTask(user.householdId!, taskId);
    if (!deleted) {
      throw createHttpError(404, 'Task not found');
    }

    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());

// POST /tasks/:id/complete
export const completeTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<CompleteTaskInput>;
    const taskId = event.pathParameters?.id;
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }

    // TODO: Get actual user name from Cognito
    const userName = user.email.split('@')[0];

    const task = await taskService.completeTask(
      user.householdId!,
      taskId,
      user.userId,
      userName,
      validatedBody.notes
    );

    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(completeTaskSchema));

// GET /tasks/templates  (public)
// Curated catalog; changes only on deploy. Cache aggressively at the edge
// so the picker doesn't burn Lambda invocations per page-load.
export const listTemplates = createHandler(async (): Promise<APIGatewayProxyResult> => {
  const { TEMPLATES } = await import('../../models/taskTemplates.js');
  return cacheableResponse(TEMPLATES, {
    maxAgeSeconds: 3600,
    visibility: 'public',
  });
});

// POST /plants/apply-template-bulk
//   body: { plantIds: string[], templateId: string }
// Applies a template to every plant in `plantIds`. Same task creation
// loop as applyTemplate, just iterated per plant. Caps at 50 plants per
// call so a hostile/buggy client can't fan out a 5000-plant write.
export const applyTemplateBulk = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ApplyTemplateBulkInput>;
    const plantIds = validatedBody.plantIds;
    const templateId = validatedBody.templateId;

    const { TEMPLATES } = await import('../../models/taskTemplates.js');
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) throw createHttpError(404, 'Unknown template');

    const applied: Array<{ plantId: string; taskIds: string[] }> = [];
    const skipped: Array<{ plantId: string; reason: string }> = [];
    for (const plantId of plantIds) {
      const plant = await plantService.getPlant(user.householdId!, plantId);
      if (!plant) {
        skipped.push({ plantId, reason: 'not_found' });
        continue;
      }
      const taskIds: string[] = [];
      for (const taskDef of tpl.tasks) {
        const t = await taskService.createTask(
          {
            plantId,
            type: taskDef.type,
            customType: taskDef.customType,
            frequency: taskDef.frequencyDays,
            notes: taskDef.notes,
          },
          user.householdId!,
          user.userId,
          plant.name
        );
        taskIds.push(t.id);
      }
      applied.push({ plantId, taskIds });
    }
    return successResponse({ applied, skipped });
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(applyTemplateBulkSchema));

// POST /plants/:plantId/apply-template
//   body: { templateId: string }
// Synthesizes the underlying tasks from the template into the plant's task list.
// Idempotent if the same template is applied twice — duplicates are allowed
// because the user may genuinely want two of the same recurring task on
// different cadences. Trim later if it becomes a UX problem.
export const applyTemplate = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ApplyTemplateInput>;
    const plantId = event.pathParameters?.plantId;
    if (!plantId) {
      throw createHttpError(400, 'plantId is required');
    }
    const templateId = validatedBody.templateId;

    const { TEMPLATES } = await import('../../models/taskTemplates.js');
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) throw createHttpError(404, 'Unknown template');

    const plant = await plantService.getPlant(user.householdId!, plantId);
    if (!plant) throw createHttpError(404, 'Plant not found');

    const created = [];
    for (const taskDef of tpl.tasks) {
      const task = await taskService.createTask(
        {
          plantId,
          type: taskDef.type,
          customType: taskDef.customType,
          frequency: taskDef.frequencyDays,
          notes: taskDef.notes,
        },
        user.householdId!,
        user.userId,
        plant.name
      );
      created.push(task);
    }
    return successResponse({ created });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(applyTemplateSchema));

// POST /tasks/:id/snooze
export const snoozeTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SnoozeTaskInput>;
    const taskId = event.pathParameters?.id;
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }
    const task = await taskService.snoozeTask(user.householdId!, taskId, validatedBody.days);
    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    // Activity feed entry, with the optional reason ("snoozed (rain
    // expected)"). Best-effort — recordActivity logs-and-continues.
    await recordActivity({
      type: 'task.snoozed',
      householdId: user.householdId!,
      actorId: user.userId,
      actorName: user.email.split('@')[0],
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        days: validatedBody.days,
        reason: validatedBody.reason ?? null,
        note: validatedBody.note ?? null,
      },
    });

    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(snoozeTaskSchema));

// POST /tasks/:id/claim — take an unassigned task ("up for grabs").
// Atomic in the service: 409 when someone else claimed it first.
export const claimTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const taskId = event.pathParameters?.id;
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }
    const result = await taskService.claimTask(user.householdId!, taskId, user.userId);
    if (result === null) {
      throw createHttpError(404, 'Task not found');
    }
    if (result === 'already_claimed') {
      throw createHttpError(409, 'Already claimed');
    }
    return successResponse(result);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());

// POST /tasks/:id/unclaim — release a task; only the current assignee may.
export const unclaimTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const taskId = event.pathParameters?.id;
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }
    const result = await taskService.unclaimTask(user.householdId!, taskId, user.userId);
    if (result === null) {
      throw createHttpError(404, 'Task not found');
    }
    if (result === 'not_assignee') {
      throw createHttpError(403, 'Only the current assignee can unclaim this task');
    }
    return successResponse(result);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());

// PUT /tasks/vacation — set (upsert) a vacation window. Body userId defaults
// to the caller; setting it for someone else requires the admin role.
export const setVacation = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SetVacationInput>;
    const householdId = user.householdId!;
    const targetUserId = validatedBody.userId ?? user.userId;

    if (targetUserId !== user.userId && user.householdRole !== 'admin') {
      throw createHttpError(403, 'Admin role required to set vacation for another member');
    }
    if (validatedBody.coveredBy === targetUserId) {
      throw createHttpError(400, 'coveredBy must be a different household member');
    }

    // Read-only membership checks via householdService (vacation state itself
    // lives in the task domain).
    const coverMember = await householdService.getMemberByUserId(
      householdId,
      validatedBody.coveredBy
    );
    if (!coverMember) {
      throw createHttpError(400, 'coveredBy must be a household member');
    }
    const targetMember = await householdService.getMemberByUserId(householdId, targetUserId);
    if (!targetMember) {
      throw createHttpError(404, 'Member not found');
    }

    const window = await taskService.setVacationWindow(
      householdId,
      {
        userId: targetUserId,
        coveredBy: validatedBody.coveredBy,
        coveredByName: coverMember.name,
        startDate: validatedBody.startDate,
        endDate: validatedBody.endDate,
      },
      user.userId
    );
    return successResponse(window);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(setVacationSchema));

// DELETE /tasks/vacation/:userId — cancel a window (self or admin).
export const deleteVacation = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const targetUserId = event.pathParameters?.userId;
    if (!targetUserId) {
      throw createHttpError(400, 'User ID is required');
    }
    if (targetUserId !== user.userId && user.householdRole !== 'admin') {
      throw createHttpError(403, 'Admin role required to cancel another member’s vacation');
    }
    const deleted = await taskService.deleteVacationWindow(user.householdId!, targetUserId);
    if (!deleted) {
      throw createHttpError(404, 'Vacation window not found');
    }
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());

// GET /tasks/vacation — active + upcoming windows for the household.
export const listVacations = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const windows = await taskService.listVacationWindows(user.householdId!);
    return successResponse(windows);
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /tasks': listTasks,
  'GET /tasks/upcoming': getUpcomingTasks,
  'POST /tasks': createTask,
  'GET /tasks/{id}': getTask,
  'PUT /tasks/{id}': updateTask,
  'DELETE /tasks/{id}': deleteTask,
  'POST /tasks/{id}/complete': completeTask,
  'GET /tasks/templates': listTemplates,
  'POST /plants/apply-template-bulk': applyTemplateBulk,
  'POST /plants/{plantId}/apply-template': applyTemplate,
  'POST /tasks/{id}/snooze': snoozeTask,
  'POST /tasks/{id}/claim': claimTask,
  'POST /tasks/{id}/unclaim': unclaimTask,
  'PUT /tasks/vacation': setVacation,
  'DELETE /tasks/vacation/{userId}': deleteVacation,
  'GET /tasks/vacation': listVacations,
});
