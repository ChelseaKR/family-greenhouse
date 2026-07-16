/**
 * Client for the PUBLIC plant-sitter endpoints (GET /sitter/{token},
 * POST /sitter/{token}/tasks/{taskId}/complete).
 *
 * These are unauthenticated by design — a plant sitter opens a time-boxed link
 * and never signs in — so we call them with a bare `fetch` against the same
 * API base the axios client uses, exactly like petToxicityService. That
 * deliberately skips the auth-header + 401-refresh interceptors, which would
 * otherwise try to refresh a (non-existent) session for an anonymous visitor.
 *
 * The 256-bit token in the path is the only credential. The endpoints expose
 * NO member identity, private notes, or household climate location. They do
 * include the current space and placement note as explicit care directions.
 */

export interface SitterTask {
  taskId: string;
  plantName: string;
  taskType: string;
  dueDate: string;
  spaceName: string | null;
  placementNote: string | null;
  overdue: boolean;
}

export interface SitterView {
  /** Friendly, non-PII household label the creator chose, if any. */
  label: string | null;
  expiresAt: string;
  tasks: SitterTask[];
}

/** Thrown when the link is missing/expired/revoked (404) so the page can show
 *  a friendly "this link is no longer active" message rather than a raw error. */
export class SitterLinkInactiveError extends Error {
  constructor() {
    super('This sitter link is invalid or has expired.');
    this.name = 'SitterLinkInactiveError';
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const sitterService = {
  async getView(token: string, signal?: AbortSignal): Promise<SitterView> {
    const response = await fetch(`${API_URL}/sitter/${encodeURIComponent(token)}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404 || response.status === 410) {
      throw new SitterLinkInactiveError();
    }
    if (!response.ok) {
      throw new Error(`Sitter view failed (${response.status})`);
    }
    return (await response.json()) as SitterView;
  },

  async completeTask(token: string, taskId: string): Promise<SitterTask> {
    const response = await fetch(
      `${API_URL}/sitter/${encodeURIComponent(token)}/tasks/${encodeURIComponent(taskId)}/complete`,
      { method: 'POST', headers: { Accept: 'application/json' } }
    );
    if (response.status === 404 || response.status === 410) {
      throw new SitterLinkInactiveError();
    }
    if (!response.ok) {
      throw new Error(`Sitter completion failed (${response.status})`);
    }
    return (await response.json()) as SitterTask;
  },
};
