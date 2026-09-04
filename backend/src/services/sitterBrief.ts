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
 */
import * as plantService from './plantService.js';
import * as spaceService from './spaceService.js';
import * as taskService from './taskService.js';
import { lookupToxicity, type PetToxicityMatch } from '../models/petToxicity.js';

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
  /** Latest photo (the plant row tracks the most recent one). */
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
 * A plant's care words, preferring a structured care rule ("we bottom-water
 * this one") over free-text notes. `careRule` is read defensively: it is not
 * on every deployment's Plant row yet, and a brief must work either way.
 */
export function resolveCareNote(plant: { notes?: string | null; careRule?: string | null }): {
  careNote: string | null;
  careNoteSource: 'rule' | 'notes' | null;
} {
  const rule = plant.careRule?.trim();
  if (rule) return { careNote: rule, careNoteSource: 'rule' };
  const notes = plant.notes?.trim();
  if (notes) return { careNote: notes, careNoteSource: 'notes' };
  return { careNote: null, careNoteSource: null };
}

/**
 * Look the plant up in the curated pet-toxicity table. The species field is
 * tried first (it is the botanical name the table indexes); the display name
 * is a fallback for the many plants recorded as just "Monstera". We return
 * the matched entry's own names as `matchedOn` so the brief can show WHAT it
 * matched — a reader can see for themselves whether the match is right,
 * instead of trusting a verdict attached to a nickname.
 */
export function resolvePetSafety(plant: {
  name: string;
  species?: string | null;
}): (PetToxicityMatch & { matchedOn: string }) | null {
  for (const query of [plant.species, plant.name]) {
    if (!query) continue;
    const [match] = lookupToxicity(query, 1);
    if (match) return { ...match, matchedOn: query };
  }
  return null;
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

  const entries: SitterBriefPlant[] = plants.map((plant) => ({
    plantId: plant.id,
    name: plant.name,
    spaceName: plant.spaceId
      ? (spaceNames.get(plant.spaceId) ?? plant.location ?? null)
      : (plant.location ?? null),
    placementNote: plant.placementNote?.trim() || null,
    ...resolveCareNote(plant),
    photoUrl: plant.imageUrl ?? null,
    petSafety: resolvePetSafety(plant),
    tasks: tasksByPlant.get(plant.id) ?? [],
  }));

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
