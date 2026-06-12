/**
 * Pure parsing + validation logic for the bulk-import page. Kept free of
 * React so it's unit-testable: file text in → normalized candidate rows →
 * per-row Zod validation results out.
 *
 * Accepted input shapes:
 *  - JSON, bare import shape:       [{ name, species?, ... , tasks? }]
 *  - JSON, request-body shape:      { plants: [ ... ] }
 *  - JSON, the app's own export:    { format: 'family-greenhouse-export',
 *                                     households: [{ plants, tasks }] }
 *    (plants from every household are flattened; tasks re-attached by
 *     plantId; export `createdAt` becomes `acquiredAt`)
 *  - CSV with a header row. The app's own plant-export headers
 *    (id,name,species,location,notes,tags,createdAt,updatedAt) are
 *    recognized; extra columns are ignored and only `name` is required.
 *    `tags` is split on `|`. The OWASP formula-guard apostrophe the export
 *    adds is stripped so exports round-trip cleanly.
 */
import { z } from 'zod';
import { parseCsvObjects, unescapeFormulaGuard } from '@/utils/csv';

export interface ImportTaskDraft {
  type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  customType?: string;
  frequency: number;
  assignedTo?: string;
  notes?: string;
}

export interface ImportPlantDraft {
  name: string;
  species?: string;
  location?: string;
  notes?: string;
  tags?: string[];
  acquiredAt?: string;
  tasks?: ImportTaskDraft[];
}

// Mirrors backend/src/models/schemas.ts importPlantSchema (client-side copy
// so the preview can flag bad rows before any network call).
const importTaskDraftSchema = z.object({
  type: z.enum(['water', 'fertilize', 'prune', 'repot', 'custom']),
  customType: z.string().max(50).optional(),
  frequency: z.number().int().min(1).max(365),
  assignedTo: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});

export const importPlantDraftSchema = z.object({
  name: z.string().min(1).max(100),
  species: z.string().max(100).optional(),
  location: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  acquiredAt: z.string().max(40).optional(),
  tasks: z.array(importTaskDraftSchema).max(10).optional(),
});

export interface ParsedRow {
  /** Position in the source file (0-based, excluding the CSV header). */
  index: number;
  /** Best-effort display name even when the row is invalid. */
  displayName: string;
  /** Present only when the row validated cleanly. */
  data?: ImportPlantDraft;
  /** Zod issues keyed by dotted field path. */
  errors: Array<{ field: string; message: string }>;
}

/** Max rows the backend accepts per request — the page submits in batches. */
export const IMPORT_BATCH_SIZE = 100;

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    return tags.length > 0 ? tags : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const tags = value
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);
    return tags.length > 0 ? tags : undefined;
  }
  return undefined;
}

function asFrequency(value: unknown): number | unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

/**
 * Normalize one candidate object (from JSON or a CSV row) into the draft
 * shape: pick only known fields, drop null/empty values, coerce tags and
 * task frequencies. Unknown/extra fields are intentionally discarded so an
 * export-shaped plant (id, status, imageUrl, ...) imports cleanly.
 */
export function normalizeCandidate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    // name is the one required field; keep whatever is there (including a
    // non-string) so Zod reports it instead of us silently dropping the row.
    name: typeof raw.name === 'string' ? raw.name.trim() : raw.name,
  };
  const species = asOptionalString(raw.species);
  if (species !== undefined) out.species = species;
  const location = asOptionalString(raw.location);
  if (location !== undefined) out.location = location;
  const notes = asOptionalString(raw.notes);
  if (notes !== undefined) out.notes = notes;
  const tags = asTags(raw.tags);
  if (tags !== undefined) out.tags = tags;
  const acquiredAt = asOptionalString(raw.acquiredAt) ?? asOptionalString(raw.createdAt);
  if (acquiredAt !== undefined) out.acquiredAt = acquiredAt;

  if (Array.isArray(raw.tasks) && raw.tasks.length > 0) {
    out.tasks = raw.tasks.map((t) => {
      if (t === null || typeof t !== 'object') return t;
      const task = t as Record<string, unknown>;
      const draft: Record<string, unknown> = {
        type: task.type,
        frequency: asFrequency(task.frequency),
      };
      const customType = asOptionalString(task.customType);
      if (customType !== undefined) draft.customType = customType;
      const assignedTo = asOptionalString(task.assignedTo);
      if (assignedTo !== undefined) draft.assignedTo = assignedTo;
      const taskNotes = asOptionalString(task.notes);
      if (taskNotes !== undefined) draft.notes = taskNotes;
      return draft;
    });
  }
  return out;
}

export class ImportParseError extends Error {
  /** i18n key suffix under `importPlants.errors.` */
  constructor(
    public readonly reason: 'invalidJson' | 'unrecognizedJson' | 'missingNameColumn' | 'emptyFile'
  ) {
    super(reason);
    this.name = 'ImportParseError';
  }
}

type ExportTask = Record<string, unknown> & { plantId?: unknown };

/** Extract candidate plant objects from any of the accepted JSON shapes. */
export function extractCandidatesFromJson(text: string): Record<string, unknown>[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportParseError('invalidJson');
  }

  if (Array.isArray(data)) {
    return data.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object');
  }

  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.plants)) {
      return obj.plants.filter(
        (p): p is Record<string, unknown> => p !== null && typeof p === 'object'
      );
    }
    // The app's own JSON export: flatten households, re-attach tasks.
    if (Array.isArray(obj.households)) {
      const out: Record<string, unknown>[] = [];
      for (const hh of obj.households) {
        if (hh === null || typeof hh !== 'object') continue;
        const { plants, tasks } = hh as { plants?: unknown; tasks?: unknown };
        if (!Array.isArray(plants)) continue;
        const tasksByPlant = new Map<unknown, ExportTask[]>();
        if (Array.isArray(tasks)) {
          for (const t of tasks) {
            if (t === null || typeof t !== 'object') continue;
            const task = t as ExportTask;
            const list = tasksByPlant.get(task.plantId) ?? [];
            list.push(task);
            tasksByPlant.set(task.plantId, list);
          }
        }
        for (const p of plants) {
          if (p === null || typeof p !== 'object') continue;
          const plant = p as Record<string, unknown>;
          const plantTasks = tasksByPlant.get(plant.id) ?? [];
          out.push(plantTasks.length > 0 ? { ...plant, tasks: plantTasks } : plant);
        }
      }
      return out;
    }
  }

  throw new ImportParseError('unrecognizedJson');
}

/** Extract candidate plant objects from header-based CSV text. */
export function extractCandidatesFromCsv(text: string): Record<string, unknown>[] {
  const { headers, rows } = parseCsvObjects(text);
  if (headers.length === 0) {
    throw new ImportParseError('emptyFile');
  }
  if (!headers.includes('name')) {
    throw new ImportParseError('missingNameColumn');
  }
  return rows.map((row) => {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      clean[key] = unescapeFormulaGuard(value);
    }
    // CSV column names are lowercased by parseCsvObjects.
    if (typeof clean.acquiredat === 'string') clean.acquiredAt = clean.acquiredat;
    if (typeof clean.createdat === 'string') clean.createdAt = clean.createdat;
    return clean;
  });
}

/**
 * Parse file text into candidates by kind, normalize, and validate each row
 * client-side. Never throws on a bad ROW (that's a per-row error in the
 * preview) — only on a file we can't read at all (ImportParseError).
 */
export function parseImportFile(kind: 'csv' | 'json', text: string): ParsedRow[] {
  const candidates =
    kind === 'json' ? extractCandidatesFromJson(text) : extractCandidatesFromCsv(text);
  if (candidates.length === 0) {
    throw new ImportParseError('emptyFile');
  }
  return candidates.map((raw, index) => {
    const normalized = normalizeCandidate(raw);
    const result = importPlantDraftSchema.safeParse(normalized);
    const displayName =
      typeof normalized.name === 'string' && normalized.name !== ''
        ? normalized.name
        : `#${index + 1}`;
    if (result.success) {
      return { index, displayName, data: result.data, errors: [] };
    }
    return {
      index,
      displayName,
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'row',
        message: issue.message,
      })),
    };
  });
}

/** Detect file kind from name/MIME; null when neither looks like csv/json. */
export function detectFileKind(file: { name: string; type: string }): 'csv' | 'json' | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || file.type === 'text/csv') return 'csv';
  if (name.endsWith('.json') || file.type === 'application/json') return 'json';
  return null;
}
