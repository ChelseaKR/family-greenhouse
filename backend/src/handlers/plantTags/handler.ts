/**
 * Plant Tags (ADR 0016) — the `plantTags` Lambda group.
 *
 * Two surfaces share this file because they share one threat model:
 *
 *   MANAGEMENT (auth=jwt): issue / re-issue / revoke a tag per plant, list a
 *   household's tags for the print sheet, and set the household PIN. Gated
 *   on the plan (`plans.ts` → `features.plantTags` / `limits.tags`).
 *
 *   PUBLIC (auth=none): `GET /tag/{token}` and `POST /tag/{token}/tasks/
 *   {taskId}/complete`. The 256-bit token in the path is the only credential.
 *   Security posture mirrors the public sitter routes, narrowed to one plant:
 *     - No authMiddleware: anonymous by design ("Grandma won't install it").
 *     - IP rate limit as a probe brake; the per-tag PIN lockout (persisted in
 *       DynamoDB) is the real brute-force control when a PIN is set.
 *     - plantTagService.getActiveTag is generic on failure (single 404).
 *     - The task-complete path checks that the task belongs to the tag's
 *       PLANT, not merely its household — a forged taskId for the household's
 *       other plants is refused.
 *     - The response exposes the plant's name, species, photo, notes, due
 *       tasks and the FIRST NAME of whoever last did each — that last line is
 *       the feature ("last watered Tuesday by Dad"), and the PIN exists for
 *       households that don't want it readable off a photographed label.
 *       Never member ids/emails, never other plants, never the household's
 *       saved location.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  requireHousehold,
  requireAdmin,
} from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import * as plantTagService from '../../services/plantTagService.js';
import * as plantService from '../../services/plantService.js';
import * as taskService from '../../services/taskService.js';
import * as billing from '../../services/billing.js';
import { recordActivity } from '../../services/activity.js';
import { getPlan, plantTagAllowance } from '../../models/plans.js';
import type { Plant, TaskCompletion } from '../../models/types.js';
import { successResponse, createdResponse, noContentResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

/** Header a scan page sends once the household PIN has been entered. */
export const TAG_PIN_HEADER = 'x-tag-pin';
/** How far ahead the scan page looks for "due" tasks, like the sitter view. */
const DUE_WITHIN_DAYS = 7;
/** How far back we look for the most recent watering specifically. */
const HISTORY_LOOKBACK = 20;

const INACTIVE_MESSAGE = 'This plant tag is no longer active.';

function headerValue(event: APIGatewayProxyEvent, name: string): string | undefined {
  // HTTP API (v2) lower-cases header names; REST (v1) preserves case. Accept
  // either without trusting anything but the exact header.
  const headers = event.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

function frontendBaseUrl(): string {
  const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
  if (!baseUrl) {
    throw createHttpError(500, 'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate tag URLs', {
      expose: true,
    });
  }
  return baseUrl;
}

/** The management-side view of one tag: includes the token, because the
 *  household needs it to print (see ADR 0016 on why that is safe here). */
function tagResponse(tag: plantTagService.PlantTag, plant: Plant, baseUrl: string) {
  return {
    ...plantTagService.toSummary(tag),
    plantName: plant.name,
    plantSpecies: plant.species,
    plantStatus: plant.status,
    token: tag.token,
    url: `${baseUrl}/tag/${tag.token}`,
  };
}

// ---------------------------------------------------------------------------
// Management (auth=jwt, any household member)
// ---------------------------------------------------------------------------
//
// Any member may issue or revoke: a tag grants strictly LESS than a member
// already holds (one plant, read + complete), so issuing one is not a
// privilege escalation — unlike invites and sitter links, which grant access
// to the whole household. The PIN is household-wide security posture and
// stays admin-only.

// POST /plants/:plantId/tag
//
// Issue a tag for the plant. If the plant already has an active tag it is
// revoked first — this IS the re-issue call. Returns the token + URL.
export const issuePlantTag = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.plantId;
    if (!plantId) throw createHttpError(400, 'Plant ID is required');
    const householdId = user.householdId!;

    const plant = await plantService.getPlant(householdId, plantId);
    if (!plant) throw createHttpError(404, 'Plant not found');
    if (plant.status !== 'active') {
      throw createHttpError(409, 'Only a plant you are currently caring for can have a tag.');
    }

    const sub = await billing.getHouseholdSubscription(householdId);
    const plan = getPlan(sub.planId);
    const allowance = plantTagAllowance(plan);
    if (!allowance.enabled) {
      throw createHttpError(
        402,
        'Plant tags are part of the Garden plan. Upgrade to print QR labels for your plants.'
      );
    }
    // A re-issue replaces this plant's own tag, so it never counts against
    // the cap; only OTHER plants' active tags do.
    const active = await plantTagService.listActiveTags(householdId);
    const used = active.filter((tag) => tag.plantId !== plantId).length;
    if (allowance.max !== null && used >= allowance.max) {
      throw createHttpError(
        402,
        `Your ${plan.name} plan is limited to ${allowance.max} plant tags. Revoke a tag before issuing another.`
      );
    }

    const baseUrl = frontendBaseUrl();
    const tag = await plantTagService.issueTag({ householdId, plantId, createdBy: user.userId });

    audit('planttag.issued', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      targetId: plantId,
      metadata: { tagId: tag.id },
    });
    return createdResponse(tagResponse(tag, plant, baseUrl));
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit({ perWindowMs: 60_000, max: 30 }));

// DELETE /plants/:plantId/tag
//
// Revoke the plant's active tag(s). The printed label stops working on the
// next scan. 404 when the plant has no active tag.
export const revokePlantTag = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.plantId;
    if (!plantId) throw createHttpError(400, 'Plant ID is required');
    const householdId = user.householdId!;

    const revoked = await plantTagService.revokeTagsForPlant(householdId, plantId);
    if (revoked === 0) throw createHttpError(404, 'This plant has no active tag');

    audit('planttag.revoked', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      targetId: plantId,
      metadata: { revoked },
    });
    return noContentResponse();
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit({ perWindowMs: 60_000, max: 30 }));

// GET /households/:id/plant-tags
//
// Everything the print sheet and the settings tab need in one read: the
// household's ACTIVE tags (with tokens, for the QR codes), whether the PIN is
// on, and the plan allowance so the client can render the cap honestly.
export const listPlantTags = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id;
    if (!householdId) throw createHttpError(400, 'Household ID is required');
    if (user.householdId !== householdId) throw createHttpError(403, 'Access denied');

    const baseUrl = frontendBaseUrl();
    const [tags, plants, settings, sub] = await Promise.all([
      plantTagService.listActiveTags(householdId),
      plantService.getPlants(householdId, 'all'),
      plantTagService.getTagSettings(householdId),
      billing.getHouseholdSubscription(householdId),
    ]);
    const plan = getPlan(sub.planId);
    const allowance = plantTagAllowance(plan);
    const plantsById = new Map(plants.map((plant) => [plant.id, plant]));
    const printable = tags.filter((tag) => plantsById.has(tag.plantId));

    // Issuing ONE tag is not a privilege escalation (see the block above);
    // taking a copy of every token in the house in a single call is a
    // different act with a different risk profile, and tags never expire. The
    // route genuinely needs the tokens — you cannot render a QR code without
    // them — so the controls are visibility and rate, not withholding: this is
    // the only audited bulk read of secrets in the API, and the count says how
    // many walked out of the door (#451).
    audit('planttag.listed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { tags: printable.length },
    });

    return successResponse({
      tags: printable.map((tag) => tagResponse(tag, plantsById.get(tag.plantId)!, baseUrl)),
      pinEnabled: settings.pinEnabled,
      allowance: { ...allowance, used: tags.length },
      planId: plan.id,
    });
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  // Same 30/min as issue and revoke. This route was the only one in the file
  // with no limit at all, which made a full export of every tag token a single
  // free call; the limit does not stop a determined export but it removes the
  // one-shot sweep and makes a scripted one visible in the audit trail above.
  .use(userRateLimit({ perWindowMs: 60_000, max: 30 }));

// PUT /households/:id/plant-tags/pin
//
// Set (four digits) or clear (null) the household PIN for scan pages. Admin
// only: it changes what every printed label in the house will show.
const setPinSchema = z.object({
  pin: z.string().regex(plantTagService.PIN_RE, 'PIN must be exactly four digits').nullable(),
});
type SetPinInput = z.infer<typeof setPinSchema>;

export const setPlantTagPin = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<SetPinInput>;
    const householdId = event.pathParameters?.id;
    if (!householdId) throw createHttpError(400, 'Household ID is required');
    if (user.householdId !== householdId) throw createHttpError(403, 'Access denied');

    const settings = await plantTagService.setTagPin(householdId, validatedBody.pin, user.userId);
    audit('planttag.pin_changed', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: { pinEnabled: settings.pinEnabled },
    });
    return successResponse(settings);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(requireAdmin())
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(setPinSchema));

// ---------------------------------------------------------------------------
// Public (auth=none)
// ---------------------------------------------------------------------------

/** Given name only: the household chose to print this, but a photographed
 *  label should not carry a member's full name. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

interface CareProjection {
  taskType: string;
  completedAt: string;
  /** First name of the member (or the tag scanner's display name). */
  completedByName: string;
  /** True when this completion came through a plant tag. */
  viaTag: boolean;
}

function projectCompletion(completion: TaskCompletion | undefined): CareProjection | null {
  if (!completion) return null;
  const viaTag = completion.completedBy.startsWith(plantTagService.TAG_ACTOR_PREFIX);
  return {
    taskType: completion.taskType,
    completedAt: completion.completedAt,
    completedByName: viaTag ? completion.completedByName : firstName(completion.completedByName),
    viaTag,
  };
}

/** Settled-read shape (ADR 0010): a failed history read is reported as such
 *  — the scan page says "couldn't load care history", never "never watered". */
type TagHistory =
  | { status: 'ok'; lastCare: CareProjection | null; lastWatered: CareProjection | null }
  | { status: 'unavailable' };

async function readHistory(householdId: string, plantId: string): Promise<TagHistory> {
  try {
    const completions = await taskService.getTaskCompletions(
      householdId,
      plantId,
      HISTORY_LOOKBACK
    );
    return {
      status: 'ok',
      lastCare: projectCompletion(completions[0]),
      lastWatered: projectCompletion(completions.find((c) => c.taskType === 'water')),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, plantId }, 'planttag.history_read_failed');
    return { status: 'unavailable' };
  }
}

/** Resolve token → active tag → active plant, or throw the one generic 404. */
async function resolveScan(
  token: string
): Promise<{ tag: plantTagService.PlantTag; plant: Plant }> {
  const tag = await plantTagService.getActiveTag(token);
  if (!tag) throw createHttpError(404, INACTIVE_MESSAGE);
  const plant = await plantService.getPlant(tag.householdId, tag.plantId);
  // A tag for a plant that died / was given away / was archived is dead too:
  // the scanner should not be able to "water" a plant nobody is caring for.
  if (!plant || plant.status !== 'active') throw createHttpError(404, INACTIVE_MESSAGE);
  return { tag, plant };
}

/** Enforce the household PIN. 401 = needs a PIN (or the one sent was wrong),
 *  423 = locked after too many wrong tries. `details` carries the machine-
 *  readable state so the scan page can tell the two 401 cases apart. */
async function enforcePin(tag: plantTagService.PlantTag, event: APIGatewayProxyEvent) {
  const presented = headerValue(event, TAG_PIN_HEADER);
  const check = await plantTagService.verifyTagPin(tag, presented);
  switch (check.verdict) {
    case 'ok':
      return;
    case 'required':
      throw createHttpError(401, 'This plant tag needs the household PIN.', {
        details: { pinRequired: true, reason: 'required' },
      });
    case 'wrong':
      throw createHttpError(401, 'That PIN is not right.', {
        details: { pinRequired: true, reason: 'wrong' },
      });
    case 'locked':
      throw createHttpError(423, 'Too many wrong PINs. Try again in a few minutes.', {
        details: { pinRequired: true, reason: 'locked', lockedUntil: check.lockedUntil },
      });
  }
}

// GET /tag/:token
//
// The scan page: plant name, "last watered <when> by <first name>", the care
// notes (house rules, brief §4.10), and this plant's due/overdue tasks.
export const getTagView = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { tag, plant } = await resolveScan(event.pathParameters?.token ?? '');
    await enforcePin(tag, event);

    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + DUE_WITHIN_DAYS);
    const cutoffIso = cutoff.toISOString();
    const nowIso = now.toISOString();

    const [tasks, history] = await Promise.all([
      taskService.getTasksForPlant(tag.householdId, tag.plantId),
      readHistory(tag.householdId, tag.plantId),
    ]);

    return successResponse({
      plantName: plant.name,
      species: plant.species,
      imageUrl: plant.imageUrl,
      // `careRule` (structured house rules, brief §4.10) does not exist yet;
      // the free-text notes are the household's care conventions today.
      careNotes: plant.notes,
      history,
      tasks: tasks
        .filter((task) => task.nextDue <= cutoffIso)
        .map((task) => ({
          taskId: task.id,
          taskType: task.customType || task.type,
          dueDate: task.nextDue,
          overdue: task.nextDue < nowIso,
        })),
    });
  }
  // Anonymous. 60/min per IP absorbs a page load + a few retries while
  // blunting token scraping; the PIN lockout is the real brake.
).use(rateLimit({ perWindowMs: 60_000, max: 60 }));

// POST /tag/:token/tasks/:taskId/complete
//
// "I just did this." Completes ONE of the tagged plant's tasks, attributed to
// the display name the scanner typed ("Grandma") with a `tag:{id}` actor id
// and `viaTag` on the activity event, parallel to `viaSitter`.
const completeTagTaskSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  // Occurrence token from the GET view so a retried tap can't complete the
  // NEXT cycle as well.
  expectedNextDue: z.string().datetime().optional(),
});
type CompleteTagTaskInput = z.infer<typeof completeTagTaskSchema>;

/** Keep the typed name printable: no control/format characters, collapsed
 *  whitespace. Anything left is what the activity feed shows. */
function cleanDisplayName(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export const completeTagTask = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<CompleteTagTaskInput>;
    const taskId = event.pathParameters?.taskId ?? '';
    if (!taskId) throw createHttpError(400, 'Task ID is required');

    const { tag, plant } = await resolveScan(event.pathParameters?.token ?? '');
    await enforcePin(tag, event);

    const displayName = cleanDisplayName(validatedBody.displayName);
    if (!displayName) throw createHttpError(400, 'Tell us who you are so the household knows.');

    // ONE-plant scope: the task must belong to the tag's plant, not merely
    // the household. A forged taskId for a sibling plant is simply not found.
    const existing = await taskService.getTask(tag.householdId, taskId);
    if (!existing || existing.plantId !== tag.plantId) {
      throw createHttpError(404, 'Task not found');
    }

    if (
      validatedBody.expectedNextDue !== undefined &&
      existing.nextDue !== validatedBody.expectedNextDue
    ) {
      // Already completed (a retry after a lost response). Acknowledge the
      // current state without a second completion or activity row.
      return successResponse({
        taskId: existing.id,
        taskType: existing.customType || existing.type,
        dueDate: existing.nextDue,
        completedByName: displayName,
        alreadyDone: true,
      });
    }

    const actorId = `${plantTagService.TAG_ACTOR_PREFIX}${tag.id}`;
    const task = await taskService.completeTask(
      tag.householdId,
      taskId,
      actorId,
      displayName,
      undefined,
      validatedBody.expectedNextDue
    );
    if (!task) throw createHttpError(404, 'Task not found');

    await recordActivity({
      type: 'task.completed',
      householdId: tag.householdId,
      actorId,
      actorName: displayName,
      payload: {
        taskId,
        plantId: task.plantId,
        plantName: plant.name,
        taskType: task.customType || task.type,
        viaTag: true,
      },
    });
    audit('planttag.task_completed', {
      actorId,
      householdId: tag.householdId,
      targetId: taskId,
      metadata: { plantId: tag.plantId },
    });

    return successResponse({
      taskId: task.id,
      taskType: task.customType || task.type,
      dueDate: task.nextDue,
      completedByName: displayName,
      alreadyDone: false,
    });
  }
  // Anonymous; tighter than the read (write side). 30/min per IP.
)
  .use(rateLimit({ perWindowMs: 60_000, max: 30 }))
  .use(validateBody(completeTagTaskSchema));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'POST /plants/{plantId}/tag': issuePlantTag,
  'DELETE /plants/{plantId}/tag': revokePlantTag,
  'GET /households/{id}/plant-tags': listPlantTags,
  'PUT /households/{id}/plant-tags/pin': setPlantTagPin,
  'GET /tag/{token}': getTagView,
  'POST /tag/{token}/tasks/{taskId}/complete': completeTagTask,
});
