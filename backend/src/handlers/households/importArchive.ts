/**
 * Restore a household from its own export (#669).
 *
 * One route, two modes. `preview` validates the archive, plans the restore
 * against THIS household and answers with the counts, everything that will
 * not come back, and the plan-cap verdict — writing nothing. `commit` repeats
 * the same plan and writes it, but only with the preview's `confirmDigest`, so
 * what lands is exactly what was previewed.
 *
 * Who and where:
 *   - an ADMIN of the target household, a human (never an API key);
 *   - into an EMPTY household only (no plants, tasks or spaces) — neither
 *     format version merges. Restoring into "a new household" is creating one
 *     (`POST /households`, which applies the homes cap) and restoring into it.
 *
 * What is never imported: members (assignments to non-members are cleared and
 * listed for re-inviting), billing (nothing in the archive is read as a plan,
 * subscription or entitlement — the household's caps are its own), photos,
 * spaces, and every credential. The export carries no share, sitter, kiosk,
 * tag, calendar or API token, the archive schema drops any field that is not
 * plant or task data, and no restored row is created with a token of any
 * kind, so a token hash smuggled into a file (#811) has nowhere to land.
 *
 * Private notes are restored into the same private fields and are never
 * echoed back: the preview and the result carry counts and names only.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import {
  authMiddleware,
  AuthenticatedEvent,
  rejectApiKeyPrincipal,
  requireAdmin,
  requireHousehold,
} from '../../middleware/auth.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import * as archiveImport from '../../services/archiveImport.js';
import * as billing from '../../services/billing.js';
import * as activity from '../../services/activity.js';
import * as householdService from '../../services/householdService.js';
import { getEntitledPlan, limitOf } from '../../models/plans.js';
import {
  ARCHIVE_MAX_BYTES,
  ArchiveRejectedError,
  IMPORT_TARGET_REFUSALS,
  importTargetState,
  perenualIdsIn,
  planArchiveImport,
  readArchive,
  type ArchiveImportCounts,
  type ArchiveNotRestored,
  type ImportTargetState,
  type ValidatedArchive,
} from '../../models/householdArchive.js';
import { successResponse } from '../../utils/response.js';
import { audit } from '../../utils/auditLog.js';
import { logger } from '../../utils/logger.js';

const importArchiveRequestSchema = z.object({
  mode: z.enum(['preview', 'commit']),
  /** Which household of the archive to restore; optional when it holds one. */
  sourceHouseholdId: z.string().min(1).max(64).optional(),
  /** Required for `commit`: the digest the preview returned. */
  confirmDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  archive: z.unknown(),
});

export interface ArchiveImportPreview {
  digest: string;
  source: {
    householdId: string;
    name: string;
    exportedAt: string | null;
    version: number;
    /** `verified` against the file's manifest, or `absent` (a version 1 file has none). */
    manifest: ValidatedArchive['manifest'];
  };
  counts: ArchiveImportCounts;
  notRestored: ArchiveNotRestored;
  planLimit: {
    planName: string;
    /** Active-plant cap; null is unlimited. */
    limit: number | null;
    currentActivePlants: number;
    fits: boolean;
  };
  target: { state: ImportTargetState };
  canImport: boolean;
}

export interface ArchiveImportResult {
  status: 'complete' | 'already_imported';
  imported: { plants: number; tasks: number };
  counts: ArchiveImportCounts;
  notRestored: ArchiveNotRestored;
}

function householdFrom(event: APIGatewayProxyEvent): string {
  const { user } = event as AuthenticatedEvent;
  const householdId = event.pathParameters?.id;
  if (!householdId) {
    throw createHttpError(400, 'Household ID is required');
  }
  // The same guard every households route carries: the caller's resolved
  // household (membership-checked by authMiddleware) must be the one named.
  if (user.householdId !== householdId) {
    throw createHttpError(403, 'Access denied');
  }
  return householdId;
}

function readArchiveOrRefuse(raw: unknown, sourceHouseholdId?: string): ValidatedArchive {
  try {
    return readArchive(raw, sourceHouseholdId);
  } catch (err) {
    if (err instanceof ArchiveRejectedError) {
      throw createHttpError(400, err.message, { details: { code: err.code, ...err.details } });
    }
    throw err;
  }
}

// POST /households/{id}/import-archive
export const importArchive = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = householdFrom(event);

    const request = importArchiveRequestSchema.safeParse(
      typeof event.body === 'string' ? safeJson(event.body) : event.body
    );
    if (!request.success) {
      throw createHttpError(400, 'Send the archive with a mode of "preview" or "commit".', {
        details: { code: 'invalid_request' },
      });
    }
    const { mode, sourceHouseholdId, confirmDigest } = request.data;

    // Validation first: an unreadable file costs no DynamoDB reads.
    const archive = readArchiveOrRefuse(request.data.archive, sourceHouseholdId);

    const [target, members, subscription, canonicalSpecies] = await Promise.all([
      archiveImport.readImportTarget(householdId),
      householdService.getHouseholdMembers(householdId),
      billing.getHouseholdSubscription(householdId),
      archiveImport.resolveCanonicalSpecies(perenualIdsIn(archive)),
    ]);
    // Caps follow ENTITLEMENT, the same read POST /plants makes. Nothing in
    // the archive is consulted for the plan: billing is never imported.
    const plan = getEntitledPlan(subscription);
    const limit = limitOf(plan, 'plants');

    const importPlan = planArchiveImport(archive, {
      targetHouseholdId: householdId,
      importerUserId: user.userId,
      members: new Map(members.map((m) => [m.userId, m.name])),
      canonicalSpecies,
    });

    const state = importTargetState(target.marker, target.hasData, importPlan.digest);
    const currentActivePlants = target.plantCount ?? 0;
    // A resume's counter already includes whatever landed, so it is not
    // re-checked here; the per-chunk counter condition still holds the cap.
    const fits =
      state === 'resumable' ||
      limit === null ||
      currentActivePlants + importPlan.counts.activePlants <= limit;

    if (mode === 'preview') {
      const preview: ArchiveImportPreview = {
        digest: importPlan.digest,
        source: {
          householdId: archive.household.id,
          name: archive.household.name,
          exportedAt: archive.exportedAt,
          version: archive.version,
          manifest: archive.manifest,
        },
        counts: importPlan.counts,
        notRestored: importPlan.notRestored,
        planLimit: { planName: plan.name, limit, currentActivePlants, fits },
        target: { state },
        canImport: (state === 'empty' || state === 'resumable') && fits,
      };
      return successResponse(preview);
    }

    // ---- commit ----
    if (confirmDigest !== importPlan.digest) {
      throw createHttpError(
        409,
        'The archive is not the one that was previewed. Preview it again before restoring.',
        { details: { code: 'archive_changed' } }
      );
    }
    if (state === 'already_imported') {
      // Idempotent: the same archive, already in place, adds nothing.
      const result: ArchiveImportResult = {
        status: 'already_imported',
        imported: { plants: 0, tasks: 0 },
        counts: importPlan.counts,
        notRestored: importPlan.notRestored,
      };
      return successResponse(result);
    }
    if (state === 'not_empty' || state === 'other_archive') {
      throw createHttpError(409, IMPORT_TARGET_REFUSALS[state], { details: { code: state } });
    }
    if (!fits) {
      throw createHttpError(
        402,
        `This archive has ${importPlan.counts.activePlants} active plants, and your ${plan.name} plan is limited to ${limit} plants. Nothing was restored. Upgrade the plan, or restore into a household on a larger plan.`,
        {
          details: {
            code: 'over_plan_limit',
            plan: plan.name,
            limit,
            activePlants: importPlan.counts.activePlants,
          },
        }
      );
    }

    const now = new Date().toISOString();
    try {
      await archiveImport.claimImport(householdId, {
        digest: importPlan.digest,
        importerUserId: user.userId,
        now,
        resume: state === 'resumable',
        seenPlantCount: target.plantCount,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ImportClaimLostError') {
        throw createHttpError(
          409,
          'The household changed while this restore was being prepared. Preview it again.',
          { details: { code: 'target_changed' } }
        );
      }
      throw err;
    }

    const written = await archiveImport.writeImportPlan(householdId, importPlan, {
      maxPlants: limit,
    });
    const landed = {
      plants: written.written.plants + written.alreadyPresent.plants,
      tasks: written.written.tasks + written.alreadyPresent.tasks,
    };
    const expected = { plants: importPlan.counts.plants, tasks: importPlan.counts.tasks };

    if (written.stopped !== null) {
      // Settled state: say exactly what is in place, and that the same archive
      // finishes the job. Nothing is marked complete.
      audit('archive.imported', {
        actorId: user.userId,
        actorEmail: user.email,
        householdId,
        metadata: {
          outcome: written.stopped,
          digest: importPlan.digest,
          sourceHouseholdId: archive.household.id,
          landed,
          expected,
        },
      });
      if (written.stopped === 'plan_limit') {
        throw createHttpError(
          402,
          `The restore stopped at your ${plan.name} plan's limit of ${limit} plants: ${landed.plants} of ${expected.plants} plants are in. Upgrade, then restore the same archive again to finish — nothing will be added twice.`,
          { details: { code: 'stopped_at_plan_limit', landed, expected } }
        );
      }
      throw createHttpError(
        503,
        `The restore stopped part-way: ${landed.plants} of ${expected.plants} plants and ${landed.tasks} of ${expected.tasks} tasks are in. Restore the same archive again to finish — nothing will be added twice.`,
        { expose: true, details: { code: 'interrupted', landed, expected } }
      );
    }

    await archiveImport.completeImport(householdId, {
      digest: importPlan.digest,
      now: new Date().toISOString(),
      householdName: importPlan.householdName,
      plants: expected.plants,
      tasks: expected.tasks,
    });

    // Counts and ids only — never a note, a name from the archive, or the file.
    audit('archive.imported', {
      actorId: user.userId,
      actorEmail: user.email,
      householdId,
      metadata: {
        outcome: 'complete',
        digest: importPlan.digest,
        formatVersion: archive.version,
        manifest: archive.manifest,
        sourceHouseholdId: archive.household.id,
        resumed: state === 'resumable',
        landed,
      },
    });
    if (landed.plants > 0) {
      const actor = members.find((m) => m.userId === user.userId)?.name || 'Someone';
      activity
        .recordActivity({
          type: 'plants.imported',
          householdId,
          actorId: user.userId,
          actorName: actor,
          payload: { count: landed.plants },
        })
        .catch((err) => {
          logger.warn({ err }, 'activity_record_failed');
        });
    }

    const result: ArchiveImportResult = {
      status: 'complete',
      imported: landed,
      counts: importPlan.counts,
      notRestored: importPlan.notRestored,
    };
    return successResponse(result);
  },
  // The one route that takes a whole household in a body. The guard runs
  // before the JSON parser, so an oversized upload is refused unparsed.
  { maxBodyBytes: ARCHIVE_MAX_BYTES }
)
  .use(authMiddleware())
  .use(rejectApiKeyPrincipal())
  // A restore is a few requests (preview, commit, perhaps a retry), not a
  // loop; each one parses up to 5 MiB and may write thousands of rows.
  .use(userRateLimit({ perWindowMs: 10 * 60_000, max: 20 }))
  .use(requireHousehold())
  .use(requireAdmin());

/** The JSON parser already ran for application/json; this covers a mislabelled body. */
function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw createHttpError(400, 'Invalid JSON body', { details: { code: 'not_an_archive' } });
  }
}
