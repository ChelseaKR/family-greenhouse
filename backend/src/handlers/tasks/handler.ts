import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit, rateLimit } from '../../middleware/rateLimit.js';
import * as sitterService from '../../services/sitterService.js';
import { buildSitterBrief } from '../../services/sitterBrief.js';
import { sitterBriefIncluded } from '../../services/sitterPlanGate.js';
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
import * as spaceService from '../../services/spaceService.js';
import * as householdService from '../../services/householdService.js';
import * as billing from '../../services/billing.js';
import * as doubleCare from '../../services/doubleCare.js';
import { nextDueAfterMatch } from '../../services/doubleCareRules.js';
import { getPlan, hasHouseholdToolkit, Plan } from '../../models/plans.js';
import * as householdEmails from '../../services/householdEmails.js';
import { recordActivity } from '../../services/activity.js';
import {
  successResponse,
  createdResponse,
  noContentResponse,
  cacheableResponse,
} from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

/**
 * The household's plan, or null when the billing read failed. Callers decide
 * what "unknown plan" means for them: the completion path skips the paid
 * detector (care logging is never blocked by its own gate), the drift
 * endpoints say so explicitly.
 */
async function resolvePlanBestEffort(householdId: string): Promise<Plan | null> {
  try {
    return getPlan((await billing.getHouseholdSubscription(householdId)).planId);
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'household_plan_lookup_failed');
    return null;
  }
}

/**
 * Double-care detection (household toolkit, brief §4.7). Runs BEFORE the
 * completion write: a suspected duplicate is answered with 409 DUPLICATE_CARE
 * and nothing is logged, so it is never dropped silently and never logged
 * silently. The client renders "already done <when> by <name> — log it
 * anyway?" and re-submits with `confirmDuplicate: true`; that completion is
 * tagged with the id it duplicates.
 *
 * Returns the id to tag the completion with, or undefined for an ordinary
 * completion (no toolkit, no duplicate, or a stale retry the service will
 * no-op anyway). A detector that cannot read the log comes back `unavailable`
 * and the completion proceeds untagged — the log line is the signal.
 */
async function detectDoubleCare(
  householdId: string,
  taskId: string,
  actorId: string,
  body: CompleteTaskInput
): Promise<string | undefined> {
  const plan = await resolvePlanBestEffort(householdId);
  if (!plan || !hasHouseholdToolkit(plan)) return undefined;

  const task = await taskService.getTask(householdId, taskId);
  if (!task) throw createHttpError(404, 'Task not found');
  // A retry carrying a stale occurrence token is a no-op in the service;
  // don't second-guess it with a notice about a completion it won't write.
  if (body.expectedNextDue !== undefined && task.nextDue !== body.expectedNextDue) {
    return undefined;
  }

  const check = await doubleCare.findRecentDuplicate({
    householdId,
    plantId: task.plantId,
    taskId,
    taskType: task.customType || task.type,
    actorId,
  });
  if (check.status !== 'duplicate') return undefined;

  if (!body.confirmDuplicate) {
    const { duplicate } = check;
    throw createHttpError(
      409,
      `${duplicate.completedByName} already logged ${duplicate.taskType} for ${task.plantName}. Send confirmDuplicate: true to log it anyway.`,
      { details: { code: 'DUPLICATE_CARE', plantName: task.plantName, duplicate } }
    );
  }
  return check.duplicate.completionId;
}

/**
 * Resolve a member's display name from the denormalized household member row
 * (single GetItem) — the same pattern as the plants handler's resolveActorName.
 * Persisted as `completedByName` on completion records, which drive the
 * activity feed, year-in-review byMember, and recap emails, so it must be the
 * real name ("Jane Smith"), not the email local-part ("jsmith"). Best-effort:
 * a lookup miss/failure falls back to the email local-part rather than failing
 * the completion.
 */
async function resolveCompleterName(
  householdId: string,
  userId: string,
  email: string
): Promise<string> {
  try {
    const member = await householdService.getMemberByUserId(householdId, userId);
    if (member?.name) return member.name;
  } catch (err) {
    logger.warn({ err }, 'completer_name_lookup_failed');
  }
  return email.split('@')[0];
}

/** Resolve the optional usual caregiver from a plant's current space. The
 * task service re-validates membership and ignores a stale departed member. */
async function defaultCaregiverForPlant(
  householdId: string,
  plant: { spaceId?: string | null }
): Promise<string | undefined> {
  if (!plant.spaceId) return undefined;
  return (await spaceService.getSpace(householdId, plant.spaceId))?.defaultCaregiverId ?? undefined;
}

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

    let task;
    try {
      const defaultAssigneeId =
        validatedBody.assignedTo === undefined
          ? await defaultCaregiverForPlant(user.householdId!, plant)
          : undefined;
      task = await taskService.createTask(
        validatedBody,
        user.householdId!,
        user.userId,
        plant.name,
        { defaultAssigneeId }
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AssigneeNotMemberError') {
        throw createHttpError(400, 'assignedTo must be a current household member');
      }
      throw err;
    }

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

    let task;
    try {
      task = await taskService.updateTask(user.householdId!, taskId, validatedBody);
    } catch (err) {
      if (err instanceof Error && err.name === 'AssigneeNotMemberError') {
        throw createHttpError(400, 'assignedTo must be a current household member');
      }
      throw err;
    }

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

    const userName = await resolveCompleterName(user.householdId!, user.userId, user.email);

    const duplicateOfCompletionId = await detectDoubleCare(
      user.householdId!,
      taskId,
      user.userId,
      validatedBody
    );

    // The options argument is only passed when there is something to tag, so
    // an ordinary completion keeps the six-argument call integrations rely on.
    const task = duplicateOfCompletionId
      ? await taskService.completeTask(
          user.householdId!,
          taskId,
          user.userId,
          userName,
          validatedBody.notes,
          validatedBody.expectedNextDue,
          { duplicateOfCompletionId }
        )
      : await taskService.completeTask(
          user.householdId!,
          taskId,
          user.userId,
          userName,
          validatedBody.notes,
          validatedBody.expectedNextDue
        );

    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    // Credit, not a scoreboard: when somebody else's task gets done, the person
    // whose task it was hears about it. `assignedTo` is untouched by
    // completion, so the returned task still names the owner. Best-effort and
    // swallowed — a completion must never fail because of an email — but
    // awaited, because Lambda can freeze a dangling promise on return.
    try {
      await householdEmails.notifyCoveredCompletion({
        householdId: user.householdId!,
        task,
        completedBy: user.userId,
        notes: validatedBody.notes ?? null,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, taskId }, 'household_email.care_credit_failed');
    }

    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(completeTaskSchema));

// GET /plants/:plantId/schedule-drift
//
// Schedule drift for every task of a plant (household toolkit, brief §4.7
// "Extension"): the median real interval between completions against the
// scheduled one. One read of the plant's completion partition. `available`
// is false — with a reason — when the tier lacks the toolkit or the plan
// could not be read; per-task `drift: null` carries its own reason.
export const getPlantScheduleDrift = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.plantId;
    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }
    const householdId = user.householdId!;

    const plan = await resolvePlanBestEffort(householdId);
    if (!plan) {
      return successResponse({ available: false, reason: 'plan_unavailable', tasks: [] });
    }
    if (!hasHouseholdToolkit(plan)) {
      return successResponse({ available: false, reason: 'not_in_plan', tasks: [] });
    }

    const plant = await plantService.getPlant(householdId, plantId);
    if (!plant) {
      throw createHttpError(404, 'Plant not found');
    }
    const tasks = await taskService.getTasksForPlant(householdId, plantId);
    const drift = await doubleCare.getScheduleDriftForPlant(householdId, plantId, tasks);
    return successResponse({ available: true, reason: null, tasks: drift });
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// POST /tasks/:id/match-schedule
//
// One tap on a drift suggestion. The server recomputes the drift from the
// log (never trusts a number from the client), sets the task's frequency to
// the suggested interval, re-derives the next due date from the last
// completion, and audits the change as a `task.schedule_matched` activity
// event with before/after.
export const matchTaskSchedule = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const taskId = event.pathParameters?.id;
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }
    const householdId = user.householdId!;

    const plan = await resolvePlanBestEffort(householdId);
    if (!plan) {
      throw createHttpError(503, 'Could not confirm the household plan just now. Try again.', {
        expose: true,
      });
    }
    if (!hasHouseholdToolkit(plan)) {
      throw createHttpError(
        402,
        'Schedule-drift suggestions are part of the Garden household toolkit. Upgrade to match a schedule to reality.'
      );
    }

    const task = await taskService.getTask(householdId, taskId);
    if (!task) {
      throw createHttpError(404, 'Task not found');
    }

    const reading = await doubleCare.getScheduleDriftForTask(householdId, task);
    if (reading.reason === 'history_unavailable') {
      throw createHttpError(503, 'Could not read this task’s completion history just now.', {
        expose: true,
      });
    }
    if (!reading.drift || !reading.drift.exceedsThreshold) {
      throw createHttpError(409, 'This task’s schedule already matches how often it gets done.');
    }

    const newFrequency = reading.drift.suggestedFrequency;
    const nextDue = nextDueAfterMatch(task.lastCompleted, newFrequency, new Date());
    const updated = await taskService.updateTask(householdId, taskId, {
      frequency: newFrequency,
      ...(nextDue ? { nextDue } : {}),
    });
    if (!updated) {
      throw createHttpError(404, 'Task not found');
    }

    const actorName = await resolveCompleterName(householdId, user.userId, user.email);
    await recordActivity({
      type: 'task.schedule_matched',
      householdId,
      actorId: user.userId,
      actorName,
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        previousFrequency: task.frequency,
        newFrequency,
        medianIntervalDays: reading.drift.medianIntervalDays,
        completionsConsidered: reading.completionsConsidered,
      },
    });

    return successResponse(updated);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold());

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
      const defaultAssigneeId = await defaultCaregiverForPlant(user.householdId!, plant);
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
          plant.name,
          { defaultAssigneeId }
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
    const defaultAssigneeId = await defaultCaregiverForPlant(user.householdId!, plant);
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
        plant.name,
        { defaultAssigneeId }
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
    const outcome = await taskService.snoozeTaskWithOutcome(
      user.householdId!,
      taskId,
      validatedBody.days,
      validatedBody.expectedNextDue
    );
    if (!outcome) {
      throw createHttpError(404, 'Task not found');
    }
    const { task } = outcome;

    if (outcome.changed) {
      // Resolve the member's display name so the activity feed reads "Jane
      // Smith snoozed…", matching completion, not the email local-part.
      const actorName = await resolveCompleterName(user.householdId!, user.userId, user.email);

      // Activity feed entry, with the optional reason ("snoozed (rain
      // expected)"). Best-effort — recordActivity logs-and-continues.
      await recordActivity({
        type: 'task.snoozed',
        householdId: user.householdId!,
        actorId: user.userId,
        actorName,
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
    }

    return successResponse(task);
  }
)
  .use(authMiddleware())
  .use(userRateLimit())
  .use(requireHousehold())
  .use(validateBody(snoozeTaskSchema));

// POST /tasks/:id/claim — take unassigned work or a space-default assignment.
// Explicit assignments stay protected. Atomic in the service: 409 when
// someone else claimed it first.
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

    // Tell the cover now, with the list, instead of leaving them to discover it
    // as "(covering for Sam)" inside a reminder on the day the window opens.
    // Keyed on the window's dates in the service, so re-saving is silent and
    // moving the dates is a fresh heads-up.
    try {
      await householdEmails.notifyCoverageAssigned({
        householdId,
        awayUserId: targetUserId,
        coveredBy: validatedBody.coveredBy,
        startDate: validatedBody.startDate,
        endDate: validatedBody.endDate,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, householdId }, 'household_email.coverage_failed');
    }

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

// ---------------------------------------------------------------------------
// Plant-sitter public endpoints (auth=none)
// ---------------------------------------------------------------------------
//
// These two routes are reachable WITHOUT a Cognito JWT — a plant sitter opens
// a link the household member shared and never signs in. The token in the path
// is the only credential. Security posture:
//   - No authMiddleware: anonymous by design.
//   - Hard IP-scoped rate limit (token guessing / scraping brake). The token
//     is 256-bit so it isn't guessable, but the limiter caps probe volume.
//   - sitterService.getActiveLink enforces existence + active + within the
//     [startsAt, expiresAt] window on EVERY call, and is generic on failure so
//     the endpoint isn't a token-existence oracle (single 404 for any miss).
//   - The response exposes ONLY the minimal SitterTask projection — no member
//     names/emails, no other households, no full plant records, no private
//     plant/task notes, and no household climate location. Current space and
//     placement note are intentionally shared as care directions.

// GET /sitter/{token}
//
// Validate the token, then return the household's due/overdue tasks in the
// minimal sitter shape. 404 for an invalid/expired/revoked token (generic —
// no oracle). The optional `label` is a friendly, non-PII household nickname
// the creator chose; absent → a generic greeting on the frontend. The
// lookahead is the link's own window (`expiresAt`), not a fixed seven days.
export const getSitterView = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const token = event.pathParameters?.token ?? '';
    const link = await sitterService.getActiveLink(token);
    if (!link) {
      // Generic 404 for every failure mode (missing / expired / revoked /
      // malformed) so a caller can't distinguish them and enumerate tokens.
      throw createHttpError(404, 'This sitter link is invalid or has expired.');
    }
    const [tasks, subscription] = await Promise.all([
      taskService.getSitterTasks(link.householdId, link.expiresAt),
      billing.getHouseholdSubscription(link.householdId),
    ]);
    return successResponse({
      label: link.label,
      expiresAt: link.expiresAt,
      tasks,
      // Whether THIS household's plan includes the handoff brief, so the page
      // offers it only when the link can actually open it. It says nothing
      // about the household beyond that, and only to a holder of a valid
      // token — the brief endpoint itself stays a generic 404 either way.
      briefAvailable: sitterBriefIncluded(getPlan(subscription.planId)),
    });
  }
  // No authMiddleware — anonymous sitter. 60/min per IP absorbs the
  // page-load + a few completions while blunting token scraping.
).use(rateLimit({ perWindowMs: 60_000, max: 60 }));

// GET /sitter/{token}/brief
//
// The handoff brief: the same household, seen plant by plant instead of task
// by task — space, placement, the household's own care words, the verified
// pet-toxicity entry, the latest photo, and the tasks due inside the window.
// Same token, same generic 404, same PII posture as the task view: no member
// identity, no household id, no saved climate location, no task notes.
//
// The brief is the paid half of the Away Kit (ADR 0015). On a plan that does
// not include it we answer the SAME generic 404 as an invalid token rather
// than a 402: the sitter is not the buyer, and an anonymous caller should not
// be told which tier a household is on. The creating member sees the upsell
// on the management side, where they can act on it.
export const getSitterBrief = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const token = event.pathParameters?.token ?? '';
    const link = await sitterService.getActiveLink(token);
    if (!link) {
      throw createHttpError(404, 'This sitter link is invalid or has expired.');
    }
    const plan = getPlan((await billing.getHouseholdSubscription(link.householdId)).planId);
    if (!sitterBriefIncluded(plan)) {
      throw createHttpError(404, 'This sitter link is invalid or has expired.');
    }
    return successResponse(await buildSitterBrief(link));
  }
  // Anonymous, like the task view. The brief is a heavier read (plants +
  // spaces + tasks), so the per-IP allowance is tighter than the 60/min list.
).use(rateLimit({ perWindowMs: 60_000, max: 30 }));

// POST /sitter/{token}/tasks/{taskId}/complete
//
// Complete a single task on behalf of the sitter. We re-validate the token
// (it may have expired/been revoked since the page loaded) AND confirm the
// task belongs to THIS token's household before touching it — a sitter can
// never reach across households even if they forge a taskId. Attributed as
// "a plant sitter" (no real user). Idempotent via taskService.completeTask.
const sitterCompleteTaskSchema = z
  .object({
    // Due date from the GET view. It identifies the recurrence occurrence so
    // a timeout/lost response can be retried without completing the next
    // cycle as well. Optional for backward compatibility with open links.
    expectedNextDue: z.string().datetime().optional(),
  })
  .nullish();
type SitterCompleteTaskInput = z.infer<typeof sitterCompleteTaskSchema>;

export const completeSitterTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<SitterCompleteTaskInput>;
    const token = event.pathParameters?.token ?? '';
    const taskId = event.pathParameters?.taskId ?? '';
    if (!taskId) {
      throw createHttpError(400, 'Task ID is required');
    }

    const link = await sitterService.getActiveLink(token);
    if (!link) {
      throw createHttpError(404, 'This sitter link is invalid or has expired.');
    }

    // Cross-household guard: the task MUST live in the token's household. We
    // read it scoped to link.householdId, so a taskId from any other household
    // simply isn't found here — there is no path to another partition.
    const existing = await taskService.getTask(link.householdId, taskId);
    if (!existing) {
      throw createHttpError(404, 'Task not found');
    }

    if (
      validatedBody?.expectedNextDue !== undefined &&
      existing.nextDue !== validatedBody.expectedNextDue
    ) {
      // The requested occurrence was already completed. Return the current
      // acknowledgement shape without another completion/activity record.
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

    // Synthetic, non-user actor. `completedByName` shows up in the activity
    // feed / history exactly as the prompt asks ("a plant sitter"); actorId is
    // a traceable, non-PII marker tying the action to the specific link.
    const task = await taskService.completeTask(
      link.householdId,
      taskId,
      `sitter:${link.id}`,
      'a plant sitter',
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
      actorId: `sitter:${link.id}`,
      actorName: 'a plant sitter',
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        viaSitter: true,
      },
    });

    // Return only the PII-free shape — the sitter never sees the full Task.
    return successResponse({
      taskId: task.id,
      plantName: task.plantName,
      taskType: task.customType || task.type,
      dueDate: task.nextDue,
      // The completion response is only an acknowledgement; placements are
      // supplied on GET and can change independently of the recurring task.
      spaceName: null,
      placementNote: null,
      overdue: false,
    });
  }
  // Anonymous; tighter than the read (write side). 30/min per IP.
)
  .use(rateLimit({ perWindowMs: 60_000, max: 30 }))
  .use(validateBody(sitterCompleteTaskSchema));

// Kiosk (wall display) public routes. Separate file, same group: the tasks
// Lambda already owns task listing + completion, and the kiosk is a second
// token-scoped, no-account view of exactly those two operations.
import { getKioskView, completeKioskTask } from './kiosk.js';

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /tasks': listTasks,
  'GET /tasks/upcoming': getUpcomingTasks,
  'POST /tasks': createTask,
  'GET /tasks/{id}': getTask,
  'PUT /tasks/{id}': updateTask,
  'DELETE /tasks/{id}': deleteTask,
  'POST /tasks/{id}/complete': completeTask,
  'GET /plants/{plantId}/schedule-drift': getPlantScheduleDrift,
  'POST /tasks/{id}/match-schedule': matchTaskSchedule,
  'GET /tasks/templates': listTemplates,
  'POST /plants/apply-template-bulk': applyTemplateBulk,
  'POST /plants/{plantId}/apply-template': applyTemplate,
  'POST /tasks/{id}/snooze': snoozeTask,
  'POST /tasks/{id}/claim': claimTask,
  'POST /tasks/{id}/unclaim': unclaimTask,
  'PUT /tasks/vacation': setVacation,
  'DELETE /tasks/vacation/{userId}': deleteVacation,
  'GET /tasks/vacation': listVacations,
  'GET /sitter/{token}': getSitterView,
  'GET /sitter/{token}/brief': getSitterBrief,
  'POST /sitter/{token}/tasks/{taskId}/complete': completeSitterTask,
  'GET /kiosk/{token}': getKioskView,
  'POST /kiosk/{token}/tasks/{taskId}/complete': completeKioskTask,
});
