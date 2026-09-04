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
  /** Whether this household's plan includes the handoff brief. Older
   *  backends omit it; treat `undefined` as "unknown" and don't offer the
   *  brief rather than sending the sitter to a page that 404s. */
  briefAvailable?: boolean;
}

/** One verified pet-toxicity entry, straight from the curated ASPCA-grounded
 *  table. `null` on a plant means NO VERDICT — never "safe". */
export interface SitterBriefPetSafety {
  slug: string;
  commonName: string;
  scientificName: string;
  cats: 'toxic' | 'non-toxic';
  dogs: 'toxic' | 'non-toxic';
  note: string;
  /** The plant name/species the table was matched on, so a reader can judge
   *  the match instead of trusting a verdict pinned to a nickname. */
  matchedOn: string;
}

export interface SitterBriefTask {
  taskId: string;
  taskType: string;
  dueDate: string;
  overdue: boolean;
}

export interface SitterBriefPlant {
  plantId: string;
  name: string;
  spaceName: string | null;
  placementNote: string | null;
  /** The household's own care words. `null` means they wrote none — the page
   *  says so plainly and never fills the gap with generated advice. */
  careNote: string | null;
  careNoteSource: 'rule' | 'notes' | null;
  photoUrl: string | null;
  petSafety: SitterBriefPetSafety | null;
  tasks: SitterBriefTask[];
}

export interface SitterBrief {
  label: string | null;
  startsAt: string;
  expiresAt: string;
  plants: SitterBriefPlant[];
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

  /**
   * The handoff brief. A 404 here is deliberately ambiguous on the wire (an
   * expired link and a plan without the brief answer identically), so the
   * caller gets `SitterLinkInactiveError` and the page decides what to say
   * from what it already knows about the link.
   */
  async getBrief(token: string, signal?: AbortSignal): Promise<SitterBrief> {
    const response = await fetch(`${API_URL}/sitter/${encodeURIComponent(token)}/brief`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404 || response.status === 410) {
      throw new SitterLinkInactiveError();
    }
    if (!response.ok) {
      throw new Error(`Sitter brief failed (${response.status})`);
    }
    return (await response.json()) as SitterBrief;
  },

  async completeTask(token: string, taskId: string, expectedNextDue: string): Promise<SitterTask> {
    const response = await fetch(
      `${API_URL}/sitter/${encodeURIComponent(token)}/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedNextDue }),
      }
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
