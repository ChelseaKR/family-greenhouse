import { api } from './api';

/**
 * Restoring a household from its own export (#669):
 * `POST /households/{id}/import-archive`. The server decides everything —
 * whether the file is readable, whether this household may receive it, and
 * whether the plan allows it — and this client shows what it says.
 */

export type ImportTargetState =
  'empty' | 'resumable' | 'already_imported' | 'not_empty' | 'other_archive';

export interface ArchiveImportCounts {
  plants: number;
  activePlants: number;
  pastPlants: number;
  archivedPlants: number;
  tasks: number;
  lineageLinks: number;
}

export interface ArchiveNotRestored {
  photos: number;
  spaceAssignments: number;
  unassignedTasks: number;
  reinvite: Array<{ name: string | null; tasks: number }>;
  orphanTasks: number;
  brokenLineage: number;
  unverifiedSpeciesNames: number;
}

export interface ArchiveImportPreview {
  digest: string;
  source: {
    householdId: string;
    name: string;
    exportedAt: string | null;
    version: number;
    /** `verified` against the file's own manifest; `absent` for a version 1 file, which has none. */
    manifest: 'verified' | 'absent';
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

export interface ArchiveImportRequest {
  archive: Record<string, unknown>;
  sourceHouseholdId: string;
}

export const archiveImportService = {
  async preview(householdId: string, request: ArchiveImportRequest): Promise<ArchiveImportPreview> {
    const response = await api.post<ArchiveImportPreview>(
      `/households/${householdId}/import-archive`,
      { mode: 'preview', ...request }
    );
    return response.data;
  },

  async commit(
    householdId: string,
    request: ArchiveImportRequest,
    confirmDigest: string
  ): Promise<ArchiveImportResult> {
    const response = await api.post<ArchiveImportResult>(
      `/households/${householdId}/import-archive`,
      { mode: 'commit', confirmDigest, ...request }
    );
    return response.data;
  },
};
