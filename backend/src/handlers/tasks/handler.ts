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
  CreateTaskInput,
  UpdateTaskInput,
  SnoozeTaskInput,
  CompleteTaskInput,
  ApplyTemplateInput,
  ApplyTemplateBulkInput,
  TaskFilters,
} from '../../models/schemas.js';
import * as taskService from '../../services/taskService.js';
import * as plantService from '../../services/plantService.js';
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
      filters.dueWithin = parseInt(query.dueWithin, 10);
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

    // Verify task exists
    const task = await taskService.getTask(user.householdId!, taskId);
    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    await taskService.deleteTask(user.householdId!, taskId);

    return noContentResponse();
  }
)
  .use(authMiddleware())
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
    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(snoozeTaskSchema));

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
});
