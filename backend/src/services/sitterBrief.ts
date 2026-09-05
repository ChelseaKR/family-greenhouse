/**
 * The handoff brief: everything the person covering the plants needs, built
 * ENTIRELY from what the household already recorded (ADR 0015). No inference,
 * no generated care text — a template render over `Plant`, `PlantSpace.name`,
 * `placementNote`, the plant's care rule / notes, the verified pet-toxicity
 * table, the plant's latest photo, and the tasks due inside the link window.
 *
 * Two rules this module exists to keep:
 *
 *   1. **A missing note stays missing.** Where the household wrote nothing we
 *      return `null` and the page says "no note" — we never fill the gap with
 *      plausible care advice, because a sitter cannot tell invented advice
 *      from the household's own. `careNoteSource` says which field the text
 *      came from so the page can label it honestly.
 *   2. **Every toxicity claim comes from the curated table** (`models/petToxicity.ts`,
 *      ASPCA-grounded, hand-verified — never generated, never from the
 *      enrichment cache). A plant the table does not know yields `null`, and
 *      the page says nothing about it: silence, never an implied all-clear.
 *   3. **A photo in the brief expires with the brief.** Every other sitter
 *      capability is re-checked on every call — `getActiveLink` re-reads
 *      `status` and `expiresAt`, and a revoke takes effect on the very next
 *      read. The photographs were the one thing that escaped that boundary:
 *      `plant.imageUrl` is a CloudFront URL on a behavior with no viewer
 *      authorization, cached at the edge for a year, so a sitter who saved the
 *      page (or just the image URLs) kept fetching photographs of the inside of
 *      someone's home indefinitely after the link was revoked, and so did
 *      anyone they forwarded them to. The brief now hands out a short-lived
 *      signed URL instead, re-signed on every request and never outliving the
 *      link. See #453.
 */
import * as plantService from './plantService.js';
import * as spaceService from './spaceService.js';
import * as taskService from './taskService.js';
import { type PetToxicityMatch } from '../models/petToxicity.js';
import { resolveCareNote, resolvePetSafety } from '../models/sitterBriefFields.js';
import { plantImageKeyForHousehold, signedImageUrl } from '../utils/s3.js';
import { logger } from '../utils/logger.js';

// Re-exported from models/ so this module stays the one import for brief
// building, while the dev server can take the two pure resolvers WITHOUT
// pulling the DynamoDB-backed services below in with them.
export { resolveCareNote, resolvePetSafety } from '../models/sitterBriefFields.js';

export interface SitterBriefTask {
  taskId: string;
  taskType: string;
  dueDate: string;
  overdue: boolean;
}

export interface SitterBriefPlant {
  plantId: string;
  name: string;
  /** Current space name, or the legacy free-text location. Null when unset. */
  spaceName: string | null;
  /** Where in that space, e.g. "east window, top shelf". Null when unset. */
  placementNote: string | null;
  /** The household's own care words. Null when they wrote none. */
  careNote: string | null;
  /** Which field `careNote` came from — a structured care rule, or the
   *  plant's free-text notes. Null when there is no care note at all. */
  careNoteSource: 'rule' | 'notes' | null;
  /**
   * Latest photo (the plant row tracks the most recent one), as a signed URL
   * that expires with — or before — the sitter link. Null when the plant has
   * no photo, and also when the stored URL cannot be resolved to a key inside
   * this household's own prefix: in that case we omit the photo rather than
   * fall back to the permanent public URL, because handing out a link that
   * outlives the brief is the defect this field exists to close.
   */
  photoUrl: string | null;
  /** Verified toxicity entry, or null when the curated table has no match.
   *  Null means "we have no verdict", NEVER "safe". */
  petSafety: (PetToxicityMatch & { matchedOn: string }) | null;
  /** Tasks due inside the sitter's window (empty = nothing due). */
  tasks: SitterBriefTask[];
}

export interface SitterBrief {
  label: string | null;
  startsAt: string;
  expiresAt: string;
  plants: SitterBriefPlant[];
}

/**
 * Upper bound on how long a brief's photo URL stays valid. A sitter refreshing
 * the page gets a fresh signature every time, so the URL only has to outlive
 * the page view — and the shorter it is, the less a saved copy is worth.
 *
 * It is a ceiling, not the value: the TTL is also clamped to what is left of
 * the link, so a signature can never outlive the window it was issued for.
 * (It could not have been "expiresAt" anyway — SigV4 caps a presigned URL at 7
 * days, and one signed with Lambda's temporary credentials expires with the
 * role session, while a paid sitter link runs to 90.)
 */
const PHOTO_URL_MAX_TTL_SECONDS = 60 * 60;
/** Floor, so a link in its last seconds still renders rather than 400-ing. */
const PHOTO_URL_MIN_TTL_SECONDS = 60;

function photoTtlSeconds(expiresAt: string, now: Date): number {
  const remaining = Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000);
  if (!Number.isFinite(remaining)) return PHOTO_URL_MIN_TTL_SECONDS;
  return Math.max(PHOTO_URL_MIN_TTL_SECONDS, Math.min(PHOTO_URL_MAX_TTL_SECONDS, remaining));
}

/**
 * Turn a stored plant photo URL into a signed one that dies with the link.
 *
 * Fails CLOSED: anything we cannot resolve to a key under this household's own
 * `plants/{householdId}/` prefix yields null. The plant record itself was read
 * fine — this is not a failed read being published as absence (ADR 0010) — it
 * is a deliberate refusal to hand a sitter a URL we cannot bound. The warning
 * makes the case visible in CloudWatch if it ever starts happening.
 */
async function briefPhotoUrl(
  imageUrl: string | null | undefined,
  householdId: string,
  expiresIn: number
): Promise<string | null> {
  if (!imageUrl) return null;
  const key = plantImageKeyForHousehold(imageUrl, householdId);
  if (!key) {
    logger.warn({ householdId }, 'sitter_brief.photo_url_not_signable');
    return null;
  }
  try {
    return await signedImageUrl(key, expiresIn);
  } catch (err) {
    logger.warn({ err, householdId }, 'sitter_brief.photo_sign_failed');
    return null;
  }
}

/**
 * Assemble the brief for one household over one link window.
 *
 * Ordering is the sitter's walk, not the database's: plants with work due
 * inside the window come first (soonest first), then everything else by name
 * — so the printed page opens on what has to happen and still lists the whole
 * collection for reference.
 */
export async function buildSitterBrief(
  link: { label: string | null; householdId: string; startsAt: string; expiresAt: string },
  now: Date = new Date()
): Promise<SitterBrief> {
  const cutoffIso = taskService.sitterWindowCutoff(link.expiresAt, now);
  const nowIso = now.toISOString();

  const [plants, spaces, tasks] = await Promise.all([
    plantService.getPlants(link.householdId),
    spaceService.getSpaces(link.householdId),
    taskService.getTasks(link.householdId),
  ]);

  const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
  const tasksByPlant = new Map<string, SitterBriefTask[]>();
  for (const task of tasks) {
    if (task.nextDue > cutoffIso) continue;
    const list = tasksByPlant.get(task.plantId) ?? [];
    list.push({
      taskId: task.id,
      taskType: task.customType || task.type,
      dueDate: task.nextDue,
      overdue: task.nextDue < nowIso,
    });
    tasksByPlant.set(task.plantId, list);
  }
  for (const list of tasksByPlant.values()) {
    list.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  }

  // Signing is local crypto, not I/O, but it is per-plant and async, so the
  // whole page is built in one pass rather than serially per plant.
  const photoTtl = photoTtlSeconds(link.expiresAt, now);
  const entries: SitterBriefPlant[] = await Promise.all(
    plants.map(async (plant) => ({
      plantId: plant.id,
      name: plant.name,
      spaceName: plant.spaceId
        ? (spaceNames.get(plant.spaceId) ?? plant.location ?? null)
        : (plant.location ?? null),
      placementNote: plant.placementNote?.trim() || null,
      ...resolveCareNote(plant),
      photoUrl: await briefPhotoUrl(plant.imageUrl, link.householdId, photoTtl),
      petSafety: resolvePetSafety(plant),
      tasks: tasksByPlant.get(plant.id) ?? [],
    }))
  );

  entries.sort((a, b) => {
    const aDue = a.tasks[0]?.dueDate;
    const bDue = b.tasks[0]?.dueDate;
    if (aDue && bDue) return aDue < bDue ? -1 : aDue > bDue ? 1 : a.name.localeCompare(b.name);
    if (aDue) return -1;
    if (bDue) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    label: link.label,
    startsAt: link.startsAt,
    expiresAt: link.expiresAt,
    plants: entries,
  };
}
