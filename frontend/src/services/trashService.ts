import { api } from './api';

/**
 * Household trash (#670). Deleting a plant or a task moves it here for
 * `retentionDays`; these calls list, restore, and delete-now. The server
 * decides everything about eligibility (the plant cap on restore, a task whose
 * plant is gone) and answers with a message this client shows as-is.
 */
export type TrashKind = 'plant' | 'task';

/**
 * The window the server keeps things for (`TRASH_RETENTION_DAYS` in
 * backend/src/services/trashService.ts). Used for copy written BEFORE a
 * listing has been read — the delete confirmation — and nowhere else: the
 * Trash page shows the `retentionDays` the server actually returned.
 */
export const TRASH_RETENTION_DAYS = 30;

export interface TrashEntry {
  kind: TrashKind;
  id: string;
  /** Plant name, or a task's custom label / type. */
  name: string;
  /** Task entries only: the built-in task type, for a translated label. */
  taskType: string | null;
  plantId: string | null;
  plantName: string | null;
  deletedAt: string;
  deletedByName: string;
  /** After this instant the entry can no longer be restored. */
  purgeAfter: string;
  /** Plant entries only: what went into the trash with it. */
  contents: { tasks: number; photos: number; completions: number } | null;
  /** A restore started and did not finish; restoring again completes it. */
  restoring: boolean;
}

export interface TrashListing {
  retentionDays: number;
  entries: TrashEntry[];
}

export const trashService = {
  async list(householdId: string): Promise<TrashListing> {
    const response = await api.get<TrashListing>(`/households/${householdId}/trash`);
    return response.data;
  },

  async restore(householdId: string, kind: TrashKind, id: string): Promise<TrashEntry> {
    const response = await api.post<TrashEntry>(
      `/households/${householdId}/trash/${kind}/${id}/restore`
    );
    return response.data;
  },

  async purge(householdId: string, kind: TrashKind, id: string): Promise<void> {
    await api.delete(`/households/${householdId}/trash/${kind}/${id}`);
  },
};
