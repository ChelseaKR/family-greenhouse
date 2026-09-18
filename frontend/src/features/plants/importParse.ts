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
 *     plantId; export `createdAt` becomes `acquiredAt`; a present, valid
 *     `perenualSpeciesId` is preserved so the care-guide/toxicity link
 *     survives the round-trip)
 *  - CSV with a header row, read through a COLUMN MAPPING (see "Column
 *    matching" below): the person says which of their columns holds the
 *    name, species, location, notes, tags and watering interval. Only the
 *    app's own plant-export headers (name,species,location,notes,tags) are
 *    matched automatically; every other column is the person's call.
 *    `tags` is split on `|`. The OWASP formula-guard apostrophe the export
 *    adds is stripped so exports round-trip cleanly.
 *
 * Whatever a file carries that the import will not keep — an unmatched CSV
 * column, a JSON field with no home — is reported back (`notImported`) so the
 * preview can list it. Nothing is dropped without the person seeing it.
 */
import { z } from 'zod';
import { parseCsv, unescapeFormulaGuard } from '@/utils/csv';

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
  /** Links to Perenual care-guide/toxicity data; see asPerenualSpeciesId. */
  perenualSpeciesId?: number | null;
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
  // No .nullable(): normalizeCandidate already drops anything that isn't a
  // positive integer (including an explicit null), matching the backend's
  // createPlantSchema which has no null case for a brand-new plant.
  perenualSpeciesId: z.number().int().positive().optional(),
  location: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  acquiredAt: z.string().max(40).optional(),
  tasks: z.array(importTaskDraftSchema).max(10).optional(),
});

/** A row-level problem. `code`, when present, names a translated message
 *  (`importPlants.rowErrors.<code>`); otherwise `message` is Zod's text. */
export interface ParsedRowError {
  field: string;
  message: string;
  code?: 'invalidInterval';
}

export interface ParsedRow {
  /** Position in the source file (0-based, excluding the CSV header). */
  index: number;
  /** Best-effort display name even when the row is invalid. */
  displayName: string;
  /** Present only when the row validated cleanly. */
  data?: ImportPlantDraft;
  /** Zod issues keyed by dotted field path, plus mapping problems. */
  errors: ParsedRowError[];
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

/**
 * Only a positive integer id is trusted (matches the backend's
 * createPlantSchema); a string, 0, a negative/decimal number, null, or
 * anything else from an untrusted upload is dropped rather than forwarded.
 */
function asPerenualSpeciesId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
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
  // Only the JSON-export shape realistically carries this; CSV rows simply
  // won't have the key, so this is a no-op for them rather than a clobber.
  const perenualSpeciesId = asPerenualSpeciesId(raw.perenualSpeciesId);
  if (perenualSpeciesId !== undefined) out.perenualSpeciesId = perenualSpeciesId;
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

/**
 * Normalize and validate one candidate. `extraErrors` are problems found
 * before validation (a watering interval that is not a number of days); a
 * row carrying any is invalid even when Zod would accept what is left, so a
 * bad cell is never quietly imported as a plant without its schedule.
 */
function validateCandidate(
  raw: Record<string, unknown>,
  index: number,
  extraErrors: ParsedRowError[] = []
): ParsedRow {
  const normalized = normalizeCandidate(raw);
  const result = importPlantDraftSchema.safeParse(normalized);
  const displayName =
    typeof normalized.name === 'string' && normalized.name !== ''
      ? normalized.name
      : `#${index + 1}`;
  if (result.success && extraErrors.length === 0) {
    return { index, displayName, data: result.data, errors: [] };
  }
  const zodErrors: ParsedRowError[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'row',
        message: issue.message,
      }));
  return { index, displayName, errors: [...extraErrors, ...zodErrors] };
}

/** A value that actually carries something — what "data" means when we
 *  promise to list data that will not be imported. */
function hasData(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Plant fields `normalizeCandidate` carries into the request. */
const CARRIED_PLANT_FIELDS = new Set([
  'name',
  'species',
  'perenualSpeciesId',
  'location',
  'notes',
  'tags',
  'tasks',
]);
/** Task fields `normalizeCandidate` carries into the request. */
const CARRIED_TASK_FIELDS = new Set(['type', 'customType', 'frequency', 'assignedTo', 'notes']);

/**
 * Every JSON field, across all candidates, that holds data the import will
 * not keep. `acquiredAt`/`createdAt` are listed too: the request accepts them
 * for round-trips, but the server does not persist them (the import date is
 * used), so calling them imported would be untrue. `careRule` is listed: the
 * import never writes the house rule, the one care field a share, sitter or
 * kiosk link may show.
 */
export function uncarriedJsonFields(candidates: Record<string, unknown>[]): string[] {
  const out = new Set<string>();
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(candidate)) {
      if (!hasData(value)) continue;
      if (key === 'tasks' && Array.isArray(value)) {
        for (const task of value) {
          if (task === null || typeof task !== 'object') continue;
          for (const [taskKey, taskValue] of Object.entries(task as Record<string, unknown>)) {
            if (hasData(taskValue) && !CARRIED_TASK_FIELDS.has(taskKey)) {
              out.add(`tasks.${taskKey}`);
            }
          }
        }
        continue;
      }
      if (!CARRIED_PLANT_FIELDS.has(key)) out.add(key);
    }
  }
  return [...out];
}

export interface JsonImport {
  rows: ParsedRow[];
  /** Fields holding data the import will not keep, for the preview to list. */
  notImported: string[];
}

/** Parse a JSON file: validated rows plus the fields that will not be kept. */
export function parseJsonImport(text: string): JsonImport {
  const candidates = extractCandidatesFromJson(text);
  if (candidates.length === 0) {
    throw new ImportParseError('emptyFile');
  }
  return {
    rows: candidates.map((raw, index) => validateCandidate(raw, index)),
    notImported: uncarriedJsonFields(candidates),
  };
}

// ---------------------------------------------------------------------------
// Column matching (#668)
// ---------------------------------------------------------------------------
//
// WHY THERE ARE NO PLANTA, GREG OR VERA ADAPTERS HERE
//
// #668 asked for importers for the export files of Planta, Greg and Vera.
// None could be built honestly: none of the three documents an export file
// whose structure can be checked. Researched 2026-09-17:
//
//  - Planta: the help center (https://support.getplanta.com/, sections
//    "Using Planta" and "Account and profile") describes no export. Its only
//    programmatic access is an authenticated API for Premium subscribers
//    (https://public.planta-api.com/v1, the client in
//    https://github.com/natekspencer/ha-planta), which is an account
//    integration, not a file a person can hand us.
//  - Greg: the support FAQ (https://greg.app/support/) describes no export.
//  - Vera (Bloomscape): the FAQ (https://bloomscape.com/vera-faq/) describes
//    cross-device sync only, and no export.
//
// No published sample export and no open-source parser for any of them was
// found. An adapter written from guessed headers would pass its own fixtures
// and then map the wrong column into `species` on a real file, which is worse
// than no adapter, because nobody notices until the care schedule is wrong.
//
// So the person tells us which of THEIR columns holds which detail. Nothing
// below assumes another app's column names: the only automatic match is to
// this app's own CSV export headers.

export const MAPPING_TARGETS = [
  'name',
  'species',
  'location',
  'notes',
  'tags',
  'wateringIntervalDays',
] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];

/** The column index feeding each target; `null` means "not in this file". */
export type ColumnMapping = Record<MappingTarget, number | null>;

export interface CsvTable {
  /** Header cells as written in the file (trimmed; may be empty). */
  headers: string[];
  /** Data rows, blank lines dropped, cells raw. */
  rows: string[][];
}

/** This app's own CSV export headers: the ONLY names matched automatically. */
const OWN_EXPORT_HEADERS: Partial<Record<MappingTarget, string>> = {
  name: 'name',
  species: 'species',
  location: 'location',
  notes: 'notes',
  tags: 'tags',
};

/** Read CSV text into a header row plus data rows. Throws on an empty file. */
export function readCsvTable(text: string): CsvTable {
  // Spreadsheet apps (Excel in particular) often save CSV with a UTF-8 BOM,
  // which would otherwise stick to the first header.
  const grid = parseCsv(text.replace(/^\uFEFF/, '')).filter((r) =>
    r.some((cell) => cell.trim() !== '')
  );
  if (grid.length < 2) {
    throw new ImportParseError('emptyFile');
  }
  return { headers: grid[0].map((h) => h.trim()), rows: grid.slice(1) };
}

export function emptyMapping(): ColumnMapping {
  return {
    name: null,
    species: null,
    location: null,
    notes: null,
    tags: null,
    wateringIntervalDays: null,
  };
}

/** Pre-fill the mapping from this app's own export headers, nothing else. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  for (const target of MAPPING_TARGETS) {
    const own = OWN_EXPORT_HEADERS[target];
    if (!own) continue;
    const index = headers.findIndex((h) => h.toLowerCase() === own);
    if (index !== -1) mapping[target] = index;
  }
  return mapping;
}

function columnHasData(table: CsvTable, column: number): boolean {
  return table.rows.some((row) => (row[column] ?? '').trim() !== '');
}

/** Indexes of columns that hold data but feed no target — the preview lists
 *  them, so an unmatched column never disappears unseen. */
export function unmatchedColumns(table: CsvTable, mapping: ColumnMapping): number[] {
  const used = new Set(Object.values(mapping).filter((i): i is number => i !== null));
  return table.headers.map((_, i) => i).filter((i) => !used.has(i) && columnHasData(table, i));
}

/** The first non-empty value in a column, to show beside its picker. */
export function sampleValue(table: CsvTable, column: number): string | undefined {
  for (const row of table.rows) {
    const value = unescapeFormulaGuard((row[column] ?? '').trim());
    if (value !== '') return value;
  }
  return undefined;
}

/** A watering interval must be a plain whole number of days, 1 to 365.
 *  "7 days" or "weekly" is NOT guessed at; the row says what is wrong. */
export function parseIntervalDays(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days >= 1 && days <= 365 ? days : null;
}

/**
 * Turn every data row into a validated draft through the mapping. A mapped
 * watering interval becomes one `water` task at that frequency. Imported
 * text only ever reaches `notes`, the private field; there is no target for
 * the house rule (`careRule`), so nothing from a file can reach a share,
 * sitter or kiosk link (see resolveCareNote in the backend).
 */
export function applyMapping(table: CsvTable, mapping: ColumnMapping): ParsedRow[] {
  return table.rows.map((cells, index) => {
    const cell = (target: MappingTarget): string | undefined => {
      const column = mapping[target];
      return column === null ? undefined : unescapeFormulaGuard(cells[column] ?? '');
    };
    const raw: Record<string, unknown> = {
      name: cell('name') ?? '',
      species: cell('species'),
      location: cell('location'),
      notes: cell('notes'),
      tags: cell('tags'),
    };
    const extraErrors: ParsedRowError[] = [];
    const interval = cell('wateringIntervalDays')?.trim();
    if (interval) {
      const days = parseIntervalDays(interval);
      if (days === null) {
        extraErrors.push({
          field: 'wateringIntervalDays',
          message: interval,
          code: 'invalidInterval',
        });
      } else {
        raw.tasks = [{ type: 'water', frequency: days }];
      }
    }
    return validateCandidate(raw, index, extraErrors);
  });
}

/**
 * Parse file text by kind with no person in the loop: JSON as-is, CSV with
 * the automatic (own-export) mapping only, refusing a CSV whose name column
 * it cannot find. The import page uses the pieces above instead, so a
 * foreign CSV gets a matching step rather than this refusal. Never throws on
 * a bad ROW (that's a per-row error in the preview) — only on a file we
 * can't read at all (ImportParseError).
 */
export function parseImportFile(kind: 'csv' | 'json', text: string): ParsedRow[] {
  if (kind === 'json') return parseJsonImport(text).rows;
  const table = readCsvTable(text);
  const mapping = suggestMapping(table.headers);
  if (mapping.name === null) {
    throw new ImportParseError('missingNameColumn');
  }
  return applyMapping(table, mapping);
}

/** Detect file kind from name/MIME; null when neither looks like csv/json. */
export function detectFileKind(file: { name: string; type: string }): 'csv' | 'json' | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || file.type === 'text/csv') return 'csv';
  if (name.endsWith('.json') || file.type === 'application/json') return 'json';
  return null;
}
