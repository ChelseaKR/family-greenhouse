/**
 * The plant passport's recipient half (#676): three routes that let a
 * household hand a plant on WITH its care summary, and let whoever receives it
 * add the plant to their own greenhouse with that summary as its first note.
 *
 *   POST /plants/{id}/passport-share             (jwt)   make the link
 *   GET  /plants/shared/{code}/passport          (none)  the summary, for the recipient
 *   POST /plants/shared/{code}/passport/import   (jwt)   add the plant + note
 *
 * The link is an ordinary 14-day cutting-share row carrying one extra frozen
 * block (see models/plantPassport.ts for why the server derives it and what
 * can never be in it). So the recipient still opens `/shared/{code}`, the
 * existing preview and accept routes behave exactly as they did, and every way
 * a cutting link is revoked, trashed or erased covers a passport link too.
 *
 * INERT UNTIL THE OWNER TURNS IT ON. Every route answers 404
 * PASSPORT_IMPORT_DISABLED, before auth, before any read, until Terraform's
 * `passport_import_enabled` sets PASSPORT_IMPORT_ENABLED=1 on this Lambda.
 *
 * The import is the one route that takes something from a stranger, and what
 * it takes is a 128-bit code. It has no body (`{}` or nothing; any key is a
 * 400), no field that names a household, plant or note, and it always writes
 * into the CALLER's household with a fresh plant id — it can neither read nor
 * overwrite another household's data. It creates through the same
 * `createPlant` as every other plant, so the plan's plant cap holds (402), and
 * it is idempotent per household per link (409 on a repeat).
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type middy from '@middy/core';
import createHttpError from 'http-errors';
import { createHandler, firstAllowedOrigin } from '../../middleware/handler.js';
import {
  authMiddleware,
  requireHousehold,
  type AuthenticatedEvent,
} from '../../middleware/auth.js';
import { rateLimit, userRateLimit } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validation.js';
import {
  PASSPORT_ALREADY_IMPORTED,
  PASSPORT_IMPORT_DISABLED,
  PASSPORT_IMPORT_MAX_BODY_BYTES,
  composePassportNote,
  passportImportBodySchema,
  passportImportEnabled,
} from '../../models/plantPassport.js';
import { getEntitledPlan, limitOf } from '../../models/plans.js';
import * as activity from '../../services/activity.js';
import * as billing from '../../services/billing.js';
import { resolveEmailLocaleForUser } from '../../services/email/locale.js';
import * as householdAudit from '../../services/householdAudit.js';
import * as householdService from '../../services/householdService.js';
import * as plantPassport from '../../services/plantPassport.js';
import * as plantService from '../../services/plantService.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';

/**
 * First of this route's own middleware, so a disabled feature is a 404 whatever
 * else is wrong with the request (no token, a body the schema would refuse):
 * from outside it does not exist yet. The shared base chain still runs ahead of
 * it (size guard, JSON parse, CORS), which read nothing from the household.
 */
function featureGuard(): middy.MiddlewareObj<APIGatewayProxyEvent, APIGatewayProxyResult> {
  return {
    before: () => {
      if (!passportImportEnabled()) {
        throw createHttpError(404, 'Plant passports are not available yet.', {
          details: { code: PASSPORT_IMPORT_DISABLED },
        });
      }
    },
  };
}

// POST /plants/:id/passport-share
//
// Make a passport link for a plant: a cutting-share link that also carries the
// plant's care summary, derived here from the household's own records. Any
// member may make one, like a cutting share. Rate-limited per user for the same
// reason: a link invites outside traffic.
export const sharePlantPassport = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const plantId = event.pathParameters?.id;
    if (!plantId) {
      throw createHttpError(400, 'Plant ID is required');
    }

    // Validate the base URL BEFORE persisting a live public link, as
    // `sharePlant` does: a config error after the write would mint a fresh
    // link on every retry.
    const baseUrl = process.env.FRONTEND_URL || firstAllowedOrigin();
    if (!baseUrl) {
      throw createHttpError(
        500,
        'FRONTEND_URL / ALLOWED_ORIGIN must be set to generate share URLs',
        { expose: true }
      );
    }

    const share = await plantPassport.createPassportShare(user.householdId!, plantId, user.userId);
    if (!share) {
      throw createHttpError(404, 'Plant not found');
    }

    // A public link with no other credential: admins can see that one exists.
    // Same entry as a cutting link (the code stays out of it).
    await householdAudit.recordHouseholdAudit({
      householdId: user.householdId!,
      kind: 'share_link.created',
      actor: { type: 'member', userId: user.userId },
      details: { plantId, expiresAt: share.expiresAt },
    });

    return createdResponse({
      code: share.code,
      expiresAt: share.expiresAt,
      url: `${baseUrl}/shared/${share.code}`,
    });
  }
)
  .use(featureGuard())
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }));

// GET /plants/shared/:code/passport
//
// PUBLIC (auth: none), like the cutting preview it sits beside: the recipient
// usually has no account yet. Returns the frozen summary and nothing else — the
// plant card itself comes from `GET /plants/shared/{code}`. 404 for an unknown
// or expired code AND for a link that carries no passport, so the page falls
// back to the plain cutting card. IP rate-limited like the preview.
export const getSharedPassport = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const code = event.pathParameters?.code;
    if (!code) {
      throw createHttpError(400, 'Share code is required');
    }

    const share = await plantService.getPlantShare(code);
    if (!share?.passport) {
      throw createHttpError(404, 'This share link is invalid or has expired');
    }

    return successResponse({ passport: share.passport, expiresAt: share.expiresAt });
  }
)
  .use(featureGuard())
  .use(rateLimit({ perWindowMs: 60_000, max: 30 }));

// POST /plants/shared/:code/passport/import
//
// Add the passported plant to the CALLER's household, its summary as the first
// note. Same copy as a cutting accept — name, species, house rule and tags, no
// photo (the image belongs to the sharing household) — plus the note, and no
// tasks: the recipient starts a fresh log and sets their own schedule for their
// own climate. Goes through `createPlant`, so the plan cap applies (402), and
// a household can import a given link once (409 after that).
export const importSharedPassport = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const code = event.pathParameters?.code;
    if (!code) {
      throw createHttpError(400, 'Share code is required');
    }

    const share = await plantService.getPlantShare(code);
    if (!share?.passport) {
      throw createHttpError(404, 'This share link is invalid or has expired');
    }
    const householdId = user.householdId!;

    const claim = await plantPassport.claimPassportImport(householdId, code, share.expiresAt);
    if (claim.kind === 'already') {
      throw createHttpError(409, 'This plant passport is already in your greenhouse.', {
        details: { code: PASSPORT_ALREADY_IMPORTED, plantId: claim.plantId },
      });
    }

    let plant: Awaited<ReturnType<typeof plantService.createPlant>>;
    let fromName: string;
    try {
      const sourceHousehold = await householdService.getHousehold(share.householdId);
      fromName = sourceHousehold?.name ?? 'another household';

      // The note follows the recipient's saved language, English when they
      // have not chosen one.
      const { locale } = await resolveEmailLocaleForUser(user.userId, householdId);
      const notes = composePassportNote({
        summary: share.passport,
        careRule: share.plantSnapshot.careRule,
        species: share.plantSnapshot.species,
        householdName: fromName,
        sharedOn: share.createdAt.slice(0, 10),
        locale,
      });

      const sub = await billing.getHouseholdSubscription(householdId);
      // Caps follow ENTITLEMENT, not the plan row — exactly as manual creation
      // and the cutting accept resolve them. See getEntitledPlan.
      const plan = getEntitledPlan(sub);

      try {
        plant = await plantService.createPlant(
          {
            name: share.plantSnapshot.name,
            species: share.plantSnapshot.species ?? undefined,
            notes,
            careRule: share.plantSnapshot.careRule ?? undefined,
            tags: share.plantSnapshot.tags,
          },
          householdId,
          user.userId,
          limitOf(plan, 'plants')
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'PlanLimitError') {
          throw createHttpError(
            402,
            `Your ${plan.name} plan is limited to ${limitOf(plan, 'plants')} plants. Remove or archive a plant before adding more.`
          );
        }
        throw err;
      }
    } catch (err) {
      // Nothing was created: give the claim back so a retry (after an upgrade,
      // or a transient failure) is not told it already imported.
      await plantPassport.releasePassportImport(householdId, code);
      throw err;
    }

    await plantPassport.recordPassportImport(householdId, code, plant.id);

    // Same feed entry as a cutting accept, best-effort like plant.created: the
    // import has already succeeded. The name lookup is inside the same guarded
    // block as the write, so a failed lookup skips the (advisory) feed row and
    // logs it, rather than recording a name nobody read.
    try {
      const member = await householdService.getMemberByUserId(householdId, user.userId);
      await activity.recordActivity({
        type: 'plant.shared_accepted',
        householdId,
        actorId: user.userId,
        actorName: member?.name || 'Someone',
        payload: { plantId: plant.id, plantName: plant.name, fromHouseholdName: fromName },
      });
    } catch (err) {
      logger.warn({ err }, 'activity_record_failed');
    }

    return createdResponse(plant);
  },
  { maxBodyBytes: PASSPORT_IMPORT_MAX_BODY_BYTES }
)
  .use(featureGuard())
  .use(authMiddleware())
  .use(requireHousehold())
  .use(userRateLimit())
  .use(validateBody(passportImportBodySchema));
