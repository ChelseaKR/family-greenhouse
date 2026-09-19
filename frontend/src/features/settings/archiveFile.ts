/**
 * Reading a household archive file in the browser before it is sent (#669).
 *
 * The server validates everything again and is the only authority; this is
 * here so a wrong file gets a clear answer before an upload, and so the upload
 * carries only what the restore needs. An export covers the person's profile,
 * notification preferences and EVERY household they belong to; the request
 * carries the format, the version and the one household being restored —
 * never the rest.
 *
 * Nothing read from the file is merged into another object: the chosen
 * household section is passed through as parsed, and the server refuses
 * prototype-pollution keys anywhere in it.
 */

/**
 * Mirrors ARCHIVE_FORMAT / ARCHIVE_VERSION / ARCHIVE_MAX_BYTES in
 * backend/src/models/householdArchive.ts. ARCHIVE_VERSION is the newest format
 * this app reads; every version from 1 up to it is readable (version 2 added a
 * manifest, and a version 1 file, which has none, still restores).
 */
export const ARCHIVE_FORMAT = 'family-greenhouse-export';
export const ARCHIVE_VERSION = 2;
export const ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;

export type ArchiveFileError =
  'tooLarge' | 'notJson' | 'notAnArchive' | 'newerVersion' | 'unsupportedVersion' | 'noHouseholds';

export interface ArchiveHouseholdSummary {
  id: string;
  name: string;
  plants: number;
  tasks: number;
}

export interface ArchiveFile {
  version: number;
  exportedAt: string | null;
  households: ArchiveHouseholdSummary[];
  /** The parsed document, kept only to cut the upload out of it. */
  document: Record<string, unknown>;
}

export type ArchiveFileResult =
  { ok: true; file: ArchiveFile } | { ok: false; error: ArchiveFileError; version?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a chosen file's text. `size` is the file's byte size, checked first. */
export function readArchiveFile(text: string, size: number): ArchiveFileResult {
  if (size > ARCHIVE_MAX_BYTES) return { ok: false, error: 'tooLarge' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'notJson' };
  }
  if (!isRecord(parsed) || parsed.format !== ARCHIVE_FORMAT) {
    return { ok: false, error: 'notAnArchive' };
  }
  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'unsupportedVersion' };
  }
  if (version > ARCHIVE_VERSION) return { ok: false, error: 'newerVersion', version };

  const households: ArchiveHouseholdSummary[] = [];
  if (Array.isArray(parsed.households)) {
    for (const section of parsed.households) {
      if (!isRecord(section) || typeof section.id !== 'string') continue;
      households.push({
        id: section.id,
        name: typeof section.name === 'string' ? section.name : '',
        plants: Array.isArray(section.plants) ? section.plants.length : 0,
        tasks: Array.isArray(section.tasks) ? section.tasks.length : 0,
      });
    }
  }
  if (households.length === 0) return { ok: false, error: 'noHouseholds' };

  return {
    ok: true,
    file: {
      version,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
      households,
      document: parsed,
    },
  };
}

/**
 * The request's `archive`: format, version, export time and the ONE household
 * being restored — the profile, preferences and other households stay on the
 * device.
 */
export function archiveUpload(file: ArchiveFile, householdId: string): Record<string, unknown> {
  const sections = Array.isArray(file.document.households) ? file.document.households : [];
  const section = sections.find((s) => isRecord(s) && s.id === householdId);
  return {
    format: ARCHIVE_FORMAT,
    version: file.version,
    ...(file.exportedAt ? { exportedAt: file.exportedAt } : {}),
    households: section ? [section] : [],
  };
}

/** Byte length of the JSON body a request would send, for the size cap. */
export function uploadBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}
