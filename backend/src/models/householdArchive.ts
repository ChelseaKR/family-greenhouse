/**
 * Reading a household archive back in (#669): the app's OWN `GET /me/export`
 * document (handlers/me/handler.ts `exportMe`), treated as untrusted input.
 *
 * This module is pure — no DynamoDB, no clock, no network — so the production
 * import (services/archiveImport.ts) and the dev server's mirror
 * (local-server.ts) run the same validation and the same restore plan.
 *
 * ## The format this reads, and only this format
 *
 * `{ format: 'family-greenhouse-export', version: 1, exportedAt, user,
 *    notificationPreferences, households: [{ id, name, role, joinedAt,
 *    plants, tasks }] }`, where `plants` is `plantService.getPlants(id, 'all')`
 * and `tasks` is `taskService.getTasks(id)` — every plant, and the tasks of the
 * ACTIVE plants. That is everything version 1 carries. Spaces, completion
 * history, photo timelines and photos themselves are not in it, so they cannot
 * be restored from it; the preview says so instead of implying otherwise.
 *
 * A version this build does not know — newer or otherwise — is refused with a
 * message that says which version the file is, never guessed at.
 *
 * ## Why a file the app wrote is still untrusted
 *
 * The person holding it can edit it, and so can anyone they handed it to. So:
 *   - the whole document is walked once for prototype-pollution keys and
 *     nesting depth BEFORE any schema runs (`assertSafeJson`);
 *   - every entity is parsed through an allowlist schema, so a field the export
 *     never wrote (a share token, a tag hash, a sitter link) is dropped, never
 *     carried into a row;
 *   - no id from the file becomes a storage key. Every restored row gets a new
 *     id derived from the target household and the archive's digest, which is
 *     also what makes a retried import land on the same rows;
 *   - `imageUrl` is never dereferenced, fetched or copied: an archive holds a
 *     link, not a picture, and following a file-supplied URL or key is how an
 *     import turns into a path-traversal or SSRF bug;
 *   - `canonicalSpecies` is server-derived (models/types.ts) and is re-read from
 *     the server's own species cache, never taken from the file.
 */
import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import {
  CARE_RULE_MAX_LENGTH,
  plantStatusEnum,
  seasonalCadencesSchema,
  taskTypeEnum,
} from './schemas.js';
import type { Plant, SpeciesSource, Task } from './types.js';

/** The `format` string `exportMe` writes. Anything else is not our archive. */
export const ARCHIVE_FORMAT = 'family-greenhouse-export';

/** The one archive version this build can restore. */
export const ARCHIVE_VERSION = 1;

/**
 * The largest request body the import route accepts. A Lambda's synchronous
 * payload ceiling is 6 MB and API Gateway's is 10 MB; 5 MiB stays under both
 * with room for the request envelope. At ~1 KB per plant or task (compact
 * JSON, which the client sends) that is several thousand entities — more
 * than any real household — and it bounds the parse before validation runs.
 */
export const ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;

/** Entity ceilings, checked by the schema. The plant one is the largest plan's cap. */
export const ARCHIVE_MAX_HOUSEHOLDS = 50;
export const ARCHIVE_MAX_PLANTS = 5000;
export const ARCHIVE_MAX_TASKS = 20000;

/** The export nests at most four levels (archive → household → task → cadence). */
const ARCHIVE_MAX_DEPTH = 8;

/**
 * Keys that mutate an object's prototype when a parsed document is later
 * merged or assigned. `JSON.parse` stores them as ordinary own properties, so
 * they are harmless until something copies them — which is exactly why they
 * are refused up front rather than trusted to every future copy site.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Why an archive was refused. The frontend translates each one; the message on
 * the error is the English fallback.
 */
export type ArchiveRejectionCode =
  | 'not_an_archive'
  | 'unknown_format'
  | 'unsupported_version'
  | 'unsafe_content'
  | 'invalid_content'
  | 'household_not_found'
  | 'household_required'
  | 'duplicate_id';

export class ArchiveRejectedError extends Error {
  readonly code: ArchiveRejectionCode;
  readonly details: Record<string, unknown>;
  constructor(code: ArchiveRejectionCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ArchiveRejectedError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Walk the parsed document once: refuse a prototype-pollution key anywhere,
 * and refuse nesting deeper than the export ever produces. Iterative, so a
 * hostile 10,000-deep array cannot blow the stack on the way to being refused.
 */
export function assertSafeJson(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth > ARCHIVE_MAX_DEPTH) {
      throw new ArchiveRejectedError(
        'unsafe_content',
        'This file is nested more deeply than any Family Greenhouse export, so it was not read.'
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ArchiveRejectedError(
          'unsafe_content',
          'This file contains a field name that is not allowed, so it was not read.'
        );
      }
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// Schemas — an allowlist of what version 1 carries
// ---------------------------------------------------------------------------

/** Old ids are only ever map keys and digest input; they never become storage keys. */
const archiveIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Instants as the export writes them (`toISOString`), with an offset tolerated. */
const instantSchema = z.string().datetime({ offset: true });
const optionalText = (max: number) => z.string().max(max).nullable().optional();

const archivedPlantSchema = z.object({
  id: archiveIdSchema,
  name: z.string().trim().min(1).max(100),
  species: optionalText(100),
  location: optionalText(100),
  spaceId: optionalText(64),
  placementNote: optionalText(120),
  summerSpaceId: optionalText(64),
  winterSpaceId: optionalText(64),
  imageUrl: optionalText(2000),
  notes: optionalText(1000),
  careRule: z.string().trim().max(CARE_RULE_MAX_LENGTH).nullable().optional(),
  // Absent on legacy rows, which the app has always read as active.
  status: plantStatusEnum.optional(),
  statusChangedAt: instantSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  perenualSpeciesId: z.number().int().positive().nullable().optional(),
  speciesSource: z.enum(['user', 'identified', 'catalog']).nullable().optional(),
  parentPlantId: archiveIdSchema.nullable().optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema.optional(),
});

const archivedTaskSchema = z.object({
  id: archiveIdSchema,
  plantId: archiveIdSchema,
  type: taskTypeEnum,
  customType: optionalText(50),
  frequency: z.number().int().min(1).max(365),
  seasonalCadences: seasonalCadencesSchema.nullable().optional(),
  lastCompleted: instantSchema.nullable().optional(),
  nextDue: instantSchema,
  assignedTo: z.string().max(128).nullable().optional(),
  assignedToName: optionalText(100),
  assignmentSource: z.enum(['space_default', 'move_day', 'rotation']).nullable().optional(),
  notes: optionalText(500),
  createdAt: instantSchema,
});

const householdSectionSchema = z.object({
  id: archiveIdSchema,
  name: z.string().trim().min(1).max(100),
  plants: z.array(z.unknown()).max(ARCHIVE_MAX_PLANTS),
  tasks: z.array(z.unknown()).max(ARCHIVE_MAX_TASKS),
});

const envelopeSchema = z.object({
  exportedAt: instantSchema.optional(),
  households: z.array(z.unknown()).min(1).max(ARCHIVE_MAX_HOUSEHOLDS),
});

export type ArchivedPlant = z.infer<typeof archivedPlantSchema>;
export type ArchivedTask = z.infer<typeof archivedTaskSchema>;

/** One household of an archive, validated, plus what identifies the archive. */
export interface ValidatedArchive {
  version: number;
  exportedAt: string | null;
  /** sha256 over the canonical form of the selected household's validated content. */
  digest: string;
  household: {
    id: string;
    name: string;
    plants: ArchivedPlant[];
    tasks: ArchivedTask[];
  };
}

function firstIssue(error: z.ZodError, prefix: string): Record<string, unknown> {
  const issue = error.issues[0];
  return {
    path: [prefix, ...(issue?.path ?? [])].filter((p) => p !== '').join('.'),
    problem: issue?.message ?? 'invalid',
  };
}

/** Deterministic JSON: keys sorted at every level, so equal content hashes equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Validate an archive and select ONE household from it. Throws
 * `ArchiveRejectedError` for anything this build will not restore; nothing
 * about the target household is consulted here.
 *
 * `sourceHouseholdId` picks the household when the archive holds several (an
 * export covers every household its person belonged to); with one household
 * it may be omitted.
 */
export function readArchive(raw: unknown, sourceHouseholdId?: string | null): ValidatedArchive {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArchiveRejectedError(
      'not_an_archive',
      'This is not a Family Greenhouse export file.'
    );
  }
  assertSafeJson(raw);
  const doc = raw as Record<string, unknown>;

  if (doc.format !== ARCHIVE_FORMAT) {
    throw new ArchiveRejectedError(
      'unknown_format',
      'This file is not a Family Greenhouse export, so it cannot be restored.'
    );
  }
  const version = doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ArchiveRejectedError(
      'unsupported_version',
      'This export does not say which version it is, so it cannot be restored.',
      { version: null, supported: ARCHIVE_VERSION }
    );
  }
  if (version !== ARCHIVE_VERSION) {
    throw new ArchiveRejectedError(
      'unsupported_version',
      version > ARCHIVE_VERSION
        ? `This export was made by a newer version of Family Greenhouse (format version ${version}). This version can restore format version ${ARCHIVE_VERSION} only.`
        : `This export uses format version ${version}, which this version of Family Greenhouse cannot restore.`,
      { version, supported: ARCHIVE_VERSION }
    );
  }

  const envelope = envelopeSchema.safeParse(doc);
  if (!envelope.success) {
    throw new ArchiveRejectedError(
      'invalid_content',
      'This export is incomplete or has been edited, so it cannot be restored.',
      firstIssue(envelope.error, '')
    );
  }

  const sections = envelope.data.households;
  const headers = sections.map((section) => {
    const id =
      section && typeof section === 'object' ? (section as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? id : null;
  });
  let index: number;
  if (sourceHouseholdId) {
    index = headers.indexOf(sourceHouseholdId);
    if (index === -1) {
      throw new ArchiveRejectedError(
        'household_not_found',
        'That household is not in this export.'
      );
    }
  } else if (sections.length === 1) {
    index = 0;
  } else {
    throw new ArchiveRejectedError(
      'household_required',
      'This export holds more than one household. Choose which one to restore.',
      { households: sections.length }
    );
  }

  const section = householdSectionSchema.safeParse(sections[index]);
  if (!section.success) {
    throw new ArchiveRejectedError(
      'invalid_content',
      'This export is incomplete or has been edited, so it cannot be restored.',
      firstIssue(section.error, `households.${index}`)
    );
  }

  const plants: ArchivedPlant[] = [];
  const plantIds = new Set<string>();
  for (let i = 0; i < section.data.plants.length; i += 1) {
    const parsed = archivedPlantSchema.safeParse(section.data.plants[i]);
    if (!parsed.success) {
      throw new ArchiveRejectedError(
        'invalid_content',
        'This export is incomplete or has been edited, so it cannot be restored.',
        firstIssue(parsed.error, `households.${index}.plants.${i}`)
      );
    }
    if (plantIds.has(parsed.data.id)) {
      throw new ArchiveRejectedError(
        'duplicate_id',
        'This export lists the same plant twice, which the app never does. The file may have been edited.'
      );
    }
    plantIds.add(parsed.data.id);
    plants.push(parsed.data);
  }

  const tasks: ArchivedTask[] = [];
  const taskIds = new Set<string>();
  for (let i = 0; i < section.data.tasks.length; i += 1) {
    const parsed = archivedTaskSchema.safeParse(section.data.tasks[i]);
    if (!parsed.success) {
      throw new ArchiveRejectedError(
        'invalid_content',
        'This export is incomplete or has been edited, so it cannot be restored.',
        firstIssue(parsed.error, `households.${index}.tasks.${i}`)
      );
    }
    if (taskIds.has(parsed.data.id)) {
      throw new ArchiveRejectedError(
        'duplicate_id',
        'This export lists the same task twice, which the app never does. The file may have been edited.'
      );
    }
    taskIds.add(parsed.data.id);
    tasks.push(parsed.data);
  }

  const household = { id: section.data.id, name: section.data.name, plants, tasks };
  // The digest covers exactly what the restore reads — the validated,
  // allowlisted content — plus the format it was read as. A field the schema
  // drops cannot change it, and neither can the rest of the export (the
  // person's profile, their other households).
  const digest = createHash('sha256')
    .update(canonicalJson({ format: ARCHIVE_FORMAT, version, household }))
    .digest('hex');

  return { version, exportedAt: envelope.data.exportedAt ?? null, digest, household };
}

/** The distinct catalog ids an archive names, for the species-cache lookup. */
export function perenualIdsIn(archive: ValidatedArchive): number[] {
  const ids = new Set<number>();
  for (const plant of archive.household.plants) {
    if (plant.perenualSpeciesId) ids.add(plant.perenualSpeciesId);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// The restore plan
// ---------------------------------------------------------------------------

/**
 * Namespace for restored-row ids. Fixed forever: changing it would give a
 * retried import different ids from the attempt it is finishing.
 */
const RESTORED_ID_NAMESPACE = '0b6f7a8e-4f2d-4c1b-9a51-3f0f6c2d9e47';

/**
 * The id a restored row gets: a name-based UUID over the target household, the
 * archive digest and the row's id in the archive. Deterministic on purpose —
 * a retry of the same archive into the same household writes the SAME keys,
 * so it can finish an interrupted import and can never add anything twice.
 */
export function restoredId(
  targetHouseholdId: string,
  digest: string,
  kind: 'plant' | 'task',
  archiveId: string
): string {
  return uuidv5(`${targetHouseholdId}:${digest}:${kind}:${archiveId}`, RESTORED_ID_NAMESPACE);
}

export interface ArchiveImportContext {
  targetHouseholdId: string;
  importerUserId: string;
  /** Current members of the target household: userId → display name. */
  members: ReadonlyMap<string, string>;
  /**
   * `perenualSpeciesId` → the scientific name the server's own species cache
   * holds for it, or null when the cache has no answer. Never the file's value.
   */
  canonicalSpecies: ReadonlyMap<number, string | null>;
}

/** What the archive holds that this restore will not bring back, counted. */
export interface ArchiveNotRestored {
  /** Plants with a photo: the archive carries a link, not the picture. */
  photos: number;
  /** Plants that were in a space (or had seasonal homes): spaces are not in the archive. */
  spaceAssignments: number;
  /** Tasks assigned to someone who is not a member here; restored unassigned. */
  unassignedTasks: number;
  /** Who those were, by the name the archive carries, with how many tasks each. */
  reinvite: Array<{ name: string | null; tasks: number }>;
  /** Tasks whose plant is not in the archive (skipped). */
  orphanTasks: number;
  /** Cutting links whose parent is missing or that loop back on themselves (cleared). */
  brokenLineage: number;
  /** Catalog-linked species whose scientific name the server could not re-check. */
  unverifiedSpeciesNames: number;
}

export interface ArchiveImportCounts {
  plants: number;
  activePlants: number;
  pastPlants: number;
  archivedPlants: number;
  tasks: number;
  lineageLinks: number;
}

export interface ArchiveImportPlan {
  digest: string;
  householdName: string;
  plants: Plant[];
  tasks: Task[];
  counts: ArchiveImportCounts;
  notRestored: ArchiveNotRestored;
}

const REINVITE_LIST_MAX = 20;

/** A text field as the app stores it: trimmed-empty is "none". */
function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === '' ? null : value;
}

/**
 * Provenance is restored only where it is consistent with the rest of the row,
 * by the same rules the server uses to derive it (handlers/plants/handler.ts
 * `deriveSpeciesSource`): no species name means no provenance, and `catalog`
 * needs a catalog id. A file cannot upgrade a typed name into a catalog fact.
 */
function consistentSpeciesSource(plant: ArchivedPlant): SpeciesSource | null {
  const source = plant.speciesSource ?? null;
  if (!source || !textOrNull(plant.species)) return null;
  if (source === 'catalog' && !plant.perenualSpeciesId) return null;
  return source;
}

/**
 * Remap cutting links onto the new ids, dropping any whose parent is not in
 * the archive and breaking any cycle (a loop the app's own cycle guard never
 * writes, so only an edited file carries one). Linear: each plant is walked at
 * most once.
 */
function remapLineage(
  plants: ArchivedPlant[],
  newIds: Map<string, string>
): { parentOf: Map<string, string | null>; broken: number } {
  const parent = new Map<string, string | null>();
  let broken = 0;
  for (const plant of plants) {
    const link = plant.parentPlantId ?? null;
    if (link === null) {
      parent.set(plant.id, null);
    } else if (!newIds.has(link) || link === plant.id) {
      parent.set(plant.id, null);
      broken += 1;
    } else {
      parent.set(plant.id, link);
    }
  }

  const state = new Map<string, 'walking' | 'done'>();
  for (const plant of plants) {
    if (state.has(plant.id)) continue;
    const path: string[] = [];
    let current: string | null = plant.id;
    while (current !== null && !state.has(current)) {
      state.set(current, 'walking');
      path.push(current);
      current = parent.get(current) ?? null;
    }
    if (current !== null && state.get(current) === 'walking') {
      // `current` is on this walk's own path: the link that led back into it
      // closes a loop. Cut the link OUT of `current`'s predecessor on the path.
      const closer = path[path.length - 1];
      parent.set(closer, null);
      broken += 1;
    }
    for (const id of path) state.set(id, 'done');
  }

  const parentOf = new Map<string, string | null>();
  for (const [id, link] of parent) parentOf.set(id, link === null ? null : newIds.get(link)!);
  return { parentOf, broken };
}

/**
 * Turn a validated archive into the exact rows a restore writes into the
 * target household, and count everything it will not bring back.
 *
 * Carried over as the archive states it: name, species, location text,
 * placement note, private notes, house rule, lifecycle status and when it
 * changed, tags, catalog id, provenance (where consistent), cutting lineage,
 * and each task's type, cadence, seasonal profile, last completion and next
 * due date, private notes and creation time. Assignments survive only for
 * someone who is a member of the target household.
 *
 * Not carried over: ids (new, deterministic), `createdBy` (the importing admin
 * — the archive's user ids are not members here), photos, space assignments,
 * a task's hand-off / ask-for-help state (occurrence-pinned, and naming people
 * who are not here), and every credential: no share, sitter, kiosk, tag,
 * calendar or API token exists in the export, and none is created.
 */
export function planArchiveImport(
  archive: ValidatedArchive,
  ctx: ArchiveImportContext
): ArchiveImportPlan {
  const { plants: archivedPlants, tasks: archivedTasks } = archive.household;
  const newPlantIds = new Map<string, string>();
  for (const plant of archivedPlants) {
    newPlantIds.set(plant.id, restoredId(ctx.targetHouseholdId, archive.digest, 'plant', plant.id));
  }
  const { parentOf, broken } = remapLineage(archivedPlants, newPlantIds);

  const counts: ArchiveImportCounts = {
    plants: 0,
    activePlants: 0,
    pastPlants: 0,
    archivedPlants: 0,
    tasks: 0,
    lineageLinks: 0,
  };
  const notRestored: ArchiveNotRestored = {
    photos: 0,
    spaceAssignments: 0,
    unassignedTasks: 0,
    reinvite: [],
    orphanTasks: 0,
    brokenLineage: broken,
    unverifiedSpeciesNames: 0,
  };

  const plants: Plant[] = [];
  const plantNames = new Map<string, string>();
  for (const archived of archivedPlants) {
    const status = archived.status ?? 'active';
    const perenualSpeciesId = archived.perenualSpeciesId ?? null;
    const canonical =
      perenualSpeciesId === null ? null : (ctx.canonicalSpecies.get(perenualSpeciesId) ?? null);
    if (perenualSpeciesId !== null && canonical === null) notRestored.unverifiedSpeciesNames += 1;
    if (textOrNull(archived.imageUrl)) notRestored.photos += 1;
    if (archived.spaceId || archived.summerSpaceId || archived.winterSpaceId) {
      notRestored.spaceAssignments += 1;
    }
    const parentPlantId = parentOf.get(archived.id) ?? null;
    if (parentPlantId) counts.lineageLinks += 1;

    const plant: Plant = {
      id: newPlantIds.get(archived.id)!,
      householdId: ctx.targetHouseholdId,
      name: archived.name,
      species: textOrNull(archived.species),
      location: textOrNull(archived.location),
      spaceId: null,
      placementNote: textOrNull(archived.placementNote),
      summerSpaceId: null,
      winterSpaceId: null,
      imageUrl: null,
      notes: textOrNull(archived.notes),
      careRule: textOrNull(archived.careRule),
      status,
      statusChangedAt: archived.statusChangedAt ?? null,
      tags: archived.tags ?? [],
      perenualSpeciesId,
      canonicalSpecies: canonical,
      speciesSource: consistentSpeciesSource(archived),
      parentPlantId,
      createdAt: archived.createdAt,
      createdBy: ctx.importerUserId,
      updatedAt: archived.updatedAt ?? archived.createdAt,
    };
    plants.push(plant);
    plantNames.set(archived.id, plant.name);
    counts.plants += 1;
    if (status === 'active') counts.activePlants += 1;
    else if (status === 'archived') counts.archivedPlants += 1;
    else counts.pastPlants += 1;
  }

  const reinvite = new Map<string, { name: string | null; tasks: number }>();
  const tasks: Task[] = [];
  for (const archived of archivedTasks) {
    const plantId = newPlantIds.get(archived.plantId);
    if (!plantId) {
      notRestored.orphanTasks += 1;
      continue;
    }
    const assignee = archived.assignedTo ?? null;
    const memberName = assignee === null ? undefined : ctx.members.get(assignee);
    const kept = assignee !== null && memberName !== undefined;
    if (assignee !== null && !kept) {
      notRestored.unassignedTasks += 1;
      const entry = reinvite.get(assignee) ?? {
        name: textOrNull(archived.assignedToName),
        tasks: 0,
      };
      entry.tasks += 1;
      reinvite.set(assignee, entry);
    }
    tasks.push({
      id: restoredId(ctx.targetHouseholdId, archive.digest, 'task', archived.id),
      householdId: ctx.targetHouseholdId,
      plantId,
      plantName: plantNames.get(archived.plantId)!,
      type: archived.type,
      customType: archived.type === 'custom' ? textOrNull(archived.customType) : null,
      frequency: archived.frequency,
      seasonalCadences: archived.seasonalCadences ?? null,
      lastCompleted: archived.lastCompleted ?? null,
      nextDue: archived.nextDue,
      assignedTo: kept ? assignee : null,
      assignedToName: kept ? (memberName ?? null) : null,
      assignmentSource: kept ? (archived.assignmentSource ?? null) : null,
      notes: textOrNull(archived.notes),
      createdBy: ctx.importerUserId,
      createdAt: archived.createdAt,
    });
    counts.tasks += 1;
  }
  notRestored.reinvite = [...reinvite.values()]
    .sort((a, b) => b.tasks - a.tasks)
    .slice(0, REINVITE_LIST_MAX);

  return {
    digest: archive.digest,
    householdName: archive.household.name,
    plants,
    tasks,
    counts,
    notRestored,
  };
}

// ---------------------------------------------------------------------------
// Where the target stands
// ---------------------------------------------------------------------------

/**
 * Where the target household stands for this archive:
 *   - `empty`            — nothing in it; a restore may start.
 *   - `resumable`        — this same archive started landing here and stopped;
 *                          running it again finishes it.
 *   - `already_imported` — this same archive finished landing here; a commit
 *                          adds nothing.
 *   - `not_empty`        — it has plants, tasks or spaces (version 1 never merges).
 *   - `other_archive`    — a different archive was restored here.
 */
export type ImportTargetState =
  'empty' | 'resumable' | 'already_imported' | 'not_empty' | 'other_archive';

export function importTargetState(
  marker: { digest: string; status: 'in_progress' | 'complete' } | null,
  hasData: boolean,
  digest: string
): ImportTargetState {
  if (marker) {
    if (marker.digest !== digest) return 'other_archive';
    return marker.status === 'complete' ? 'already_imported' : 'resumable';
  }
  return hasData ? 'not_empty' : 'empty';
}

/** The refusal a commit gets for a target it may not write into. */
export const IMPORT_TARGET_REFUSALS: Record<'not_empty' | 'other_archive', string> = {
  not_empty:
    'This household already has plants, tasks or spaces. Restore into an empty household — create a new one and restore into it.',
  other_archive:
    'This household was already restored from a different archive. Create a new household to restore this one.',
};
