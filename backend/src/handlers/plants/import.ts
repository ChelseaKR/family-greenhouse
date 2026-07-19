/**
 * POST /plants/import — bulk CSV/JSON import (max 100 plants per request,
 * each with up to 10 care tasks).
 *
 * Contract: PARTIAL SUCCESS, not all-or-nothing. Each row is created via
 * plantService.createPlant — the same path as single create, so the atomic
 * transactional plan-cap counter governs every row. When a row trips the cap
 * (PlanLimitError) that row and every remaining row are marked 'skipped'
 * with a plan-limit error, and the response is still a 200 carrying the
 * per-row results plus {created, skipped, planLimitHit}. The client renders
 * the partial outcome and an upgrade prompt.
 *
 * One activity entry ('plants.imported', payload {count}) is recorded for
 * the whole batch — importing 80 plants must not flood the household feed
 * with 80 rows.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import { importPlantsSchema, ImportPlantsInput } from '../../models/schemas.js';
import * as plantService from '../../services/plantService.js';
import * as taskService from '../../services/taskService.js';
import * as billing from '../../services/billing.js';
import * as activity from '../../services/activity.js';
import * as householdService from '../../services/householdService.js';
import { getPlan } from '../../models/plans.js';
import { successResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

export interface ImportRowResult {
  index: number;
  status: 'created' | 'skipped';
  plantId?: string;
  error?: string;
}

export interface ImportPlantsResponse {
  results: ImportRowResult[];
  created: number;
  skipped: number;
  planLimitHit: boolean;
}

/** Same best-effort actor-name resolution as the rest of this handler group. */
async function resolveActorName(householdId: string, userId: string): Promise<string> {
  try {
    const member = await householdService.getMemberByUserId(householdId, userId);
    return member?.name || 'Someone';
  } catch (err) {
    logger.warn({ err }, 'actor_name_lookup_failed');
    return 'Someone';
  }
}

// POST /plants/import
export const importPlants = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<ImportPlantsInput>;

    const sub = await billing.getHouseholdSubscription(user.householdId!);
    const plan = getPlan(sub.planId);
    const planLimitMessage = `Plan limit reached: your ${plan.name} plan is limited to ${plan.maxPlants} plants. Remove or archive existing plants before importing more.`;

    const results: ImportRowResult[] = [];
    let created = 0;
    let planLimitHit = false;

    // Sequential on purpose: the atomic counter in createPlant makes
    // concurrency SAFE, but sequential keeps ordering deterministic (row N
    // is the one that hits the cap, rows N+1.. are skipped) and avoids a
    // 100-wide transaction burst against the same METADATA row.
    for (let index = 0; index < validatedBody.plants.length; index++) {
      if (planLimitHit) {
        results.push({ index, status: 'skipped', error: planLimitMessage });
        continue;
      }

      const row = validatedBody.plants[index];
      // Explicit pick (acquiredAt is accepted-but-ignored; see schemas.ts).
      const plantInput = {
        name: row.name,
        species: row.species,
        location: row.location,
        notes: row.notes,
        tags: row.tags,
        perenualSpeciesId: row.perenualSpeciesId,
      };
      const tasks = row.tasks;
      try {
        const plant = await plantService.createPlant(
          plantInput,
          user.householdId!,
          user.userId,
          plan.maxPlants
        );

        // Tasks are best-effort per row: the plant exists either way, so a
        // task failure downgrades to a row-level error note, not a skip.
        let taskError: string | undefined;
        for (const taskDef of tasks ?? []) {
          try {
            await taskService.createTask(
              { ...taskDef, plantId: plant.id },
              user.householdId!,
              user.userId,
              plant.name
            );
          } catch (err) {
            logger.warn({ err, plantId: plant.id }, 'import_task_create_failed');
            // Surface a dangling-assignee row error specifically (M4); other
            // task failures keep the generic note.
            taskError =
              err instanceof Error && err.name === 'AssigneeNotMemberError'
                ? 'Plant created, but a task assignee was not a current household member'
                : 'Plant created, but one or more tasks could not be created';
          }
        }

        created += 1;
        results.push({ index, status: 'created', plantId: plant.id, error: taskError });
      } catch (err) {
        // Name check (not instanceof) so test automocks keep working.
        if (err instanceof Error && err.name === 'PlanLimitError') {
          planLimitHit = true;
          results.push({ index, status: 'skipped', error: planLimitMessage });
        } else {
          // Row-level failure: report it and keep going — partial success
          // is the contract. Don't leak internals into the row error.
          logger.warn({ err, index }, 'import_row_failed');
          results.push({ index, status: 'skipped', error: 'Could not create this plant' });
        }
      }
    }

    // ONE activity entry for the whole batch, and only if anything landed.
    if (created > 0) {
      activity
        .recordActivity({
          type: 'plants.imported',
          householdId: user.householdId!,
          actorId: user.userId,
          actorName: await resolveActorName(user.householdId!, user.userId),
          payload: { count: created },
        })
        .catch((err) => {
          logger.warn({ err }, 'activity_record_failed');
        });
    }

    const response: ImportPlantsResponse = {
      results,
      created,
      skipped: results.length - created,
      planLimitHit,
    };
    return successResponse(response);
  }
)
  .use(authMiddleware())
  // Imports are heavy (up to 100 sequential transactional writes); 5/min per
  // user still allows a 500-plant collection in one minute.
  .use(userRateLimit({ perWindowMs: 60_000, max: 5 }))
  .use(requireHousehold())
  .use(validateBody(importPlantsSchema));
