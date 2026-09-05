/**
 * Local dev-server mirror of handlers/plantTags/handler.ts (ADR 0016).
 *
 * Kept in its own module so the plant-tag surface registers into the mock
 * Express app with one call, instead of interleaving ~250 lines into
 * local-server.ts. Same contract note as the rest of the mock: every status
 * code, body shape and guard here mirrors the production Lambda so the
 * integration suite (tests/integration/plant-tags.test.ts) exercises the real
 * behaviour — one-plant scoping, plan gate, PIN + lockout, generic 404s.
 *
 * Unlike local-server.ts this file is type-checked (no `@ts-nocheck`), so the
 * request is read through the small typed helpers below rather than `any`.
 */
import type express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getEntitledPlan, plantTagAllowance } from './models/plans.js';
import type { RecordActivityInput } from './services/activity.js';
// From models/, NOT services/plantTagService.js: that module imports
// utils/dynamodb.ts, which calls requireEnv('TABLE_NAME') at import time and
// would take this whole dev server down before it could serve a request.
import { PIN_MAX_FAILURES, PIN_LOCKOUT_MS, PIN_RE, TAG_ACTOR_PREFIX } from './models/plantTags.js';

/** Mirrors plantTagService.PlantTag (PLANTTAG#{token} row). */
export interface LocalPlantTag {
  id: string;
  token: string;
  householdId: string;
  plantId: string;
  createdBy: string;
  createdAt: string;
  status: 'active' | 'revoked';
  revokedAt: string | null;
  pinFailures: number;
  pinLockedUntil: string | null;
}

/** Mirrors the HOUSEHOLD#{id} / PLANTTAG#PIN row. */
export interface LocalPlantTagPin {
  pinHash: string;
  pinSalt: string;
}

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

/** What local-server's authMiddleware stashes on the request. */
interface AuthedUser {
  userId: string;
  email: string;
  householdId: string;
  householdRole: 'admin' | 'member' | null;
}

function userOf(req: express.Request): AuthedUser {
  return (req as express.Request & { user: AuthedUser }).user;
}

function validatedBodyOf<T>(req: express.Request): T {
  return (req as express.Request & { validatedBody: T }).validatedBody;
}

/** Express 5 types a route param as `string | string[]`; ours are single. */
function param(req: express.Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** The slice of the mock DB and helpers this module needs. Passed in (rather
 *  than imported) so local-server.ts stays the only module that owns them. */
export interface PlantTagDeps {
  db: {
    plantTags: Map<string, LocalPlantTag>;
    plantTagPins: Map<string, LocalPlantTagPin>;
    households: Map<
      string,
      {
        planId?: 'seedling' | 'garden' | 'greenhouse';
        subscriptionStatus?: string;
        lifetimePlanId?: 'seedling' | 'garden' | 'greenhouse';
      }
    >;
    plants: Map<
      string,
      {
        id: string;
        householdId: string;
        name: string;
        species: string | null;
        imageUrl: string | null;
        notes: string | null;
        status: 'active' | 'died' | 'gave_away' | 'archived';
      }
    >;
    tasks: Map<
      string,
      {
        id: string;
        householdId: string;
        plantId: string;
        plantName: string;
        type: string;
        customType: string | null;
        frequency: number;
        lastCompleted: string | null;
        nextDue: string;
      }
    >;
    completions: Map<
      string,
      {
        id: string;
        householdId: string;
        plantId: string;
        taskId: string;
        taskType: string;
        completedBy: string;
        completedByName: string;
        completedAt: string;
        notes: string | null;
      }
    >;
  };
  authMiddleware: Middleware;
  requireHousehold: Middleware;
  requireAdmin: Middleware;
  validateBody: (schema: z.ZodTypeAny) => Middleware;
  recordActivity: (input: RecordActivityInput) => void;
}

const INACTIVE_MESSAGE = 'This plant tag is no longer active.';
const DUE_WITHIN_DAYS = 7;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

function baseUrl(): string {
  return (
    process.env.FRONTEND_URL ||
    process.env.ALLOWED_ORIGIN ||
    `http://localhost:${process.env.FRONTEND_PORT || 3000}`
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

function cleanDisplayName(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function registerPlantTagRoutes(app: express.Express, deps: PlantTagDeps): void {
  const { db, authMiddleware, requireHousehold, requireAdmin, validateBody, recordActivity } = deps;

  /**
   * What this household MAY START, resolved the way every production gate
   * resolves it (#476). `PLANS[h?.planId ?? 'seedling']` — what both routes
   * below used to do — is `getPlan(h?.planId)` with the fallback inlined: it
   * reads the tier on file and can see neither whether it is being paid for
   * nor a tier bought outright. local-server.ts holds the same helper over
   * its own copy of the row.
   */
  const entitledPlanFor = (householdId: string) => {
    const h = db.households.get(householdId);
    // Mapped field by field, never spread: the mock's row spells the status
    // `subscriptionStatus`, and `EntitlementSubscription` spells it `status`.
    // Handing the row over whole type-checks — every field is optional — and
    // silently drops the payment status, which is the same absence-read-as-a-
    // value this change is removing.
    return getEntitledPlan({
      planId: h?.planId,
      status: h?.subscriptionStatus,
      lifetimePlanId: h?.lifetimePlanId,
    });
  };

  const activeTagsFor = (householdId: string) =>
    [...db.plantTags.values()].filter(
      (t) => t.householdId === householdId && t.status === 'active'
    );

  const revokeTagsForPlant = (householdId: string, plantId: string): number => {
    const now = new Date().toISOString();
    let n = 0;
    for (const tag of activeTagsFor(householdId)) {
      if (tag.plantId === plantId) {
        tag.status = 'revoked';
        tag.revokedAt = now;
        n += 1;
      }
    }
    return n;
  };

  const tagResponse = (tag: LocalPlantTag) => {
    const plant = db.plants.get(tag.plantId);
    return {
      id: tag.id,
      householdId: tag.householdId,
      plantId: tag.plantId,
      createdBy: tag.createdBy,
      createdAt: tag.createdAt,
      status: tag.status,
      revokedAt: tag.revokedAt,
      plantName: plant?.name ?? '',
      plantSpecies: plant?.species ?? null,
      plantStatus: plant?.status ?? 'active',
      token: tag.token,
      url: `${baseUrl()}/tag/${tag.token}`,
    };
  };

  /** Token → active tag + active plant, else null (one generic 404). */
  const resolveScan = (token: string) => {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const tag = db.plantTags.get(token);
    if (!tag || tag.status !== 'active') return null;
    const plant = db.plants.get(tag.plantId);
    if (!plant || plant.status !== 'active') return null;
    return { tag, plant };
  };

  /** Mirrors plantTagService.verifyTagPin, including the per-tag lockout. */
  const verifyPin = (
    tag: LocalPlantTag,
    presented: string | undefined
  ): { verdict: 'ok' | 'required' | 'wrong' | 'locked'; lockedUntil?: string } => {
    const record = db.plantTagPins.get(tag.householdId);
    if (!record) return { verdict: 'ok' };
    const nowMs = Date.now();
    if (tag.pinLockedUntil && Date.parse(tag.pinLockedUntil) > nowMs) {
      return { verdict: 'locked', lockedUntil: tag.pinLockedUntil };
    }
    if (presented === undefined || presented === '') return { verdict: 'required' };
    const candidate = scryptSync(presented, record.pinSalt, 32, SCRYPT_OPTS);
    const expected = Buffer.from(record.pinHash, 'hex');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      tag.pinFailures = 0;
      tag.pinLockedUntil = null;
      return { verdict: 'ok' };
    }
    tag.pinFailures += 1;
    if (tag.pinFailures >= PIN_MAX_FAILURES) {
      tag.pinFailures = 0;
      tag.pinLockedUntil = new Date(nowMs + PIN_LOCKOUT_MS).toISOString();
      return { verdict: 'locked', lockedUntil: tag.pinLockedUntil };
    }
    return { verdict: 'wrong' };
  };

  /** Sends the PIN error response; returns true when the request must stop. */
  const pinBlocked = (tag: LocalPlantTag, req: express.Request, res: express.Response) => {
    const raw = req.headers['x-tag-pin'];
    const presented = typeof raw === 'string' ? raw : undefined;
    const check = verifyPin(tag, presented);
    if (check.verdict === 'ok') return false;
    if (check.verdict === 'locked') {
      res.status(423).json({
        message: 'Too many wrong PINs. Try again in a few minutes.',
        details: { pinRequired: true, reason: 'locked', lockedUntil: check.lockedUntil },
      });
      return true;
    }
    res.status(401).json({
      message:
        check.verdict === 'required'
          ? 'This plant tag needs the household PIN.'
          : 'That PIN is not right.',
      details: { pinRequired: true, reason: check.verdict },
    });
    return true;
  };

  // --- Management ---------------------------------------------------------

  // POST /plants/:plantId/tag
  app.post('/plants/:plantId/tag', authMiddleware, requireHousehold, (req, res) => {
    const user = userOf(req);
    const plant = db.plants.get(param(req, 'plantId'));
    if (!plant || plant.householdId !== user.householdId) {
      res.status(404).json({ message: 'Plant not found' });
      return;
    }
    if (plant.status !== 'active') {
      res
        .status(409)
        .json({ message: 'Only a plant you are currently caring for can have a tag.' });
      return;
    }
    // ENTITLEMENT, not the plan row (#476). Printing a NEW label is a new
    // grant and follows the card. Its counterpart is the public scan route
    // below, which is entitlement-checked NOWHERE and stays that way: a label
    // already stuck in a pot is a physical object, the person scanning it is
    // usually not the buyer, and bricking it over a failed charge would have
    // no remedy the scanner can reach. Revoke is ungated too — that is the
    // control.
    const plan = entitledPlanFor(user.householdId);
    const allowance = plantTagAllowance(plan);
    if (!allowance.enabled) {
      res.status(402).json({
        message:
          'Plant tags are part of the Garden plan. Upgrade to print QR labels for your plants.',
      });
      return;
    }
    const used = activeTagsFor(user.householdId).filter((t) => t.plantId !== plant.id).length;
    if (allowance.max !== null && used >= allowance.max) {
      res.status(402).json({
        message: `Your ${plan.name} plan is limited to ${allowance.max} plant tags. Revoke a tag before issuing another.`,
      });
      return;
    }
    revokeTagsForPlant(user.householdId, plant.id);
    const tag: LocalPlantTag = {
      id: uuidv4(),
      token: randomBytes(32).toString('hex'),
      householdId: user.householdId,
      plantId: plant.id,
      createdBy: user.userId,
      createdAt: new Date().toISOString(),
      status: 'active',
      revokedAt: null,
      pinFailures: 0,
      pinLockedUntil: null,
    };
    db.plantTags.set(tag.token, tag);
    res.status(201).json(tagResponse(tag));
  });

  // DELETE /plants/:plantId/tag
  app.delete('/plants/:plantId/tag', authMiddleware, requireHousehold, (req, res) => {
    const user = userOf(req);
    const revoked = revokeTagsForPlant(user.householdId, param(req, 'plantId'));
    if (revoked === 0) {
      res.status(404).json({ message: 'This plant has no active tag' });
      return;
    }
    res.status(204).end();
  });

  // GET /households/:id/plant-tags
  app.get('/households/:id/plant-tags', authMiddleware, requireHousehold, (req, res) => {
    const user = userOf(req);
    if (user.householdId !== param(req, 'id')) {
      res.status(403).json({ message: 'Access denied' });
      return;
    }
    // ENTITLEMENT, not the plan row (#476): the read side has to report the
    // allowance the WRITE side will actually enforce, or the print sheet
    // offers a household mid-dunning a cap that the issue route above would
    // then refuse. `tags` is unaffected and still lists every ACTIVE tag with
    // its token, so labels already issued can still be reprinted; only the
    // allowance to issue MORE narrows.
    const plan = entitledPlanFor(user.householdId);
    const tags = activeTagsFor(user.householdId)
      .filter((t) => db.plants.has(t.plantId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({
      tags: tags.map(tagResponse),
      pinEnabled: db.plantTagPins.has(user.householdId),
      allowance: { ...plantTagAllowance(plan), used: activeTagsFor(user.householdId).length },
      planId: plan.id,
    });
  });

  // PUT /households/:id/plant-tags/pin
  const setPinSchema = z.object({
    pin: z.string().regex(PIN_RE, 'PIN must be exactly four digits').nullable(),
  });
  app.put(
    '/households/:id/plant-tags/pin',
    authMiddleware,
    requireHousehold,
    requireAdmin,
    validateBody(setPinSchema),
    (req, res) => {
      const user = userOf(req);
      if (user.householdId !== param(req, 'id')) {
        res.status(403).json({ message: 'Access denied' });
        return;
      }
      const { pin } = validatedBodyOf<z.infer<typeof setPinSchema>>(req);
      if (pin === null) {
        db.plantTagPins.delete(user.householdId);
        res.json({ pinEnabled: false });
        return;
      }
      const salt = randomBytes(16).toString('hex');
      db.plantTagPins.set(user.householdId, {
        pinHash: scryptSync(pin, salt, 32, SCRYPT_OPTS).toString('hex'),
        pinSalt: salt,
      });
      res.json({ pinEnabled: true });
    }
  );

  // --- Public (no auth) ---------------------------------------------------

  // GET /tag/:token
  app.get('/tag/:token', (req, res) => {
    const scan = resolveScan(param(req, 'token'));
    if (!scan) {
      res.status(404).json({ message: INACTIVE_MESSAGE });
      return;
    }
    const { tag, plant } = scan;
    if (pinBlocked(tag, req, res)) return;

    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + DUE_WITHIN_DAYS);
    const cutoffIso = cutoff.toISOString();
    const nowIso = now.toISOString();

    const completions = [...db.completions.values()]
      .filter((c) => c.householdId === tag.householdId && c.plantId === tag.plantId)
      .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1))
      .slice(0, 20);
    const project = (c: (typeof completions)[number] | undefined) => {
      if (!c) return null;
      const viaTag = c.completedBy.startsWith(TAG_ACTOR_PREFIX);
      return {
        taskType: c.taskType,
        completedAt: c.completedAt,
        completedByName: viaTag ? c.completedByName : firstName(c.completedByName),
        viaTag,
      };
    };

    res.json({
      plantName: plant.name,
      species: plant.species,
      imageUrl: plant.imageUrl,
      careNotes: plant.notes,
      history: {
        status: 'ok',
        lastCare: project(completions[0]),
        lastWatered: project(completions.find((c) => c.taskType === 'water')),
      },
      tasks: [...db.tasks.values()]
        .filter((t) => t.householdId === tag.householdId && t.plantId === tag.plantId)
        .filter((t) => t.nextDue <= cutoffIso)
        .sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1))
        .map((t) => ({
          taskId: t.id,
          taskType: t.customType || t.type,
          dueDate: t.nextDue,
          overdue: t.nextDue < nowIso,
        })),
    });
  });

  // POST /tag/:token/tasks/:taskId/complete
  const completeSchema = z.object({
    displayName: z.string().trim().min(1).max(40),
    expectedNextDue: z.string().datetime().optional(),
  });
  app.post('/tag/:token/tasks/:taskId/complete', validateBody(completeSchema), (req, res) => {
    const scan = resolveScan(param(req, 'token'));
    if (!scan) {
      res.status(404).json({ message: INACTIVE_MESSAGE });
      return;
    }
    const { tag, plant } = scan;
    if (pinBlocked(tag, req, res)) return;

    const body = validatedBodyOf<z.infer<typeof completeSchema>>(req);
    const displayName = cleanDisplayName(body.displayName);
    if (!displayName) {
      res.status(400).json({ message: 'Tell us who you are so the household knows.' });
      return;
    }

    const task = db.tasks.get(param(req, 'taskId'));
    // ONE-plant scope: household match is not enough.
    if (!task || task.householdId !== tag.householdId || task.plantId !== tag.plantId) {
      res.status(404).json({ message: 'Task not found' });
      return;
    }
    const taskType = task.customType || task.type;
    if (body.expectedNextDue !== undefined && task.nextDue !== body.expectedNextDue) {
      res.json({
        taskId: task.id,
        taskType,
        dueDate: task.nextDue,
        completedByName: displayName,
        alreadyDone: true,
      });
      return;
    }

    const now = new Date();
    const nextDue = new Date(now);
    nextDue.setDate(nextDue.getDate() + task.frequency);
    task.lastCompleted = now.toISOString();
    task.nextDue = nextDue.toISOString();

    const actorId = `${TAG_ACTOR_PREFIX}${tag.id}`;
    const completionId = uuidv4();
    db.completions.set(completionId, {
      id: completionId,
      householdId: task.householdId,
      plantId: task.plantId,
      taskId: task.id,
      taskType,
      completedBy: actorId,
      completedByName: displayName,
      completedAt: now.toISOString(),
      notes: null,
    });
    recordActivity({
      type: 'task.completed',
      householdId: task.householdId,
      actorId,
      actorName: displayName,
      payload: {
        taskId: task.id,
        plantId: task.plantId,
        plantName: plant.name,
        taskType,
        viaTag: true,
      },
    });

    res.json({
      taskId: task.id,
      taskType,
      dueDate: task.nextDue,
      completedByName: displayName,
      alreadyDone: false,
    });
  });
}
