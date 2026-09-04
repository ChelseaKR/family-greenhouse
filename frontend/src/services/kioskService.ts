/**
 * Client for the PUBLIC kiosk (wall display) endpoints
 * (GET /kiosk/{token}, POST /kiosk/{token}/tasks/{taskId}/complete).
 *
 * Unauthenticated by design — a tablet on the kitchen wall never signs in —
 * so these go out through a bare `fetch` against the same API base the axios
 * client uses, exactly like sitterService and petToxicityService. That
 * deliberately skips the auth-header + 401-refresh interceptors, which would
 * otherwise try to refresh a session that does not exist.
 *
 * The 256-bit token in the path is the only credential, and it is on permanent
 * public display, so the endpoints behind this client expose no member
 * identity, no household name, no private notes, and no climate location. The
 * design rule and threat model live in `backend/src/services/kioskService.ts`.
 */

export interface KioskTask {
  taskId: string;
  plantName: string;
  taskType: string;
  dueDate: string;
  spaceName: string | null;
  placementNote: string | null;
  overdue: boolean;
}

export interface KioskView {
  /**
   * Seconds between refreshes, chosen by the household when the link was
   * issued. Server-supplied so the cost decision lives in one place; see
   * KIOSK_FALLBACK_POLL_SECONDS for what happens when it is missing.
   */
  pollIntervalSeconds: number;
  tasks: KioskTask[];
}

/**
 * Poll interval used only when the server did not send one (an older backend
 * mid-deploy). Deliberately the SAME five minutes the backend defaults to —
 * see `backend/src/services/kioskService.ts` for the cost arithmetic: this is
 * the one feature whose cost scales with wall-clock time rather than usage
 * (~$0.01/household/month at 300s, ~$0.05 at 60s), so a client-side fallback
 * that guessed faster than the server would quietly multiply the bill.
 */
export const KIOSK_FALLBACK_POLL_SECONDS = 300;

/** Thrown when the link is missing/revoked (404) so the page can show a
 *  friendly "this display has been turned off" message, not a raw error. */
export class KioskLinkInactiveError extends Error {
  constructor() {
    super('This kiosk link is invalid or has been turned off.');
    this.name = 'KioskLinkInactiveError';
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const kioskService = {
  async getView(token: string, signal?: AbortSignal): Promise<KioskView> {
    const response = await fetch(`${API_URL}/kiosk/${encodeURIComponent(token)}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404 || response.status === 410) {
      throw new KioskLinkInactiveError();
    }
    if (!response.ok) {
      // Everything else — 429, 5xx, a proxy error page — is "we could not
      // read", and the page must say so rather than render an empty list.
      throw new Error(`Kiosk view failed (${response.status})`);
    }
    const data = (await response.json()) as Partial<KioskView>;
    // A body with no `tasks` array is a read we did not get, not a household
    // with nothing to do. Defaulting it to `[]` here would put "all caught up"
    // on a wall screen on the strength of a malformed response — the exact
    // "absence rendered as a value" defect this codebase names. Throw instead;
    // the page renders "couldn't load".
    if (!Array.isArray(data.tasks)) {
      throw new Error('Kiosk view returned no task list');
    }
    return {
      // Only the interval falls back, and only to the SAME value the server
      // defaults to — a client that guessed faster would quietly raise the
      // bill (see KIOSK_FALLBACK_POLL_SECONDS).
      pollIntervalSeconds:
        typeof data.pollIntervalSeconds === 'number' && data.pollIntervalSeconds > 0
          ? data.pollIntervalSeconds
          : KIOSK_FALLBACK_POLL_SECONDS,
      tasks: data.tasks,
    };
  },

  async completeTask(token: string, taskId: string, expectedNextDue: string): Promise<KioskTask> {
    const response = await fetch(
      `${API_URL}/kiosk/${encodeURIComponent(token)}/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedNextDue }),
      }
    );
    if (response.status === 404 || response.status === 410) {
      throw new KioskLinkInactiveError();
    }
    if (!response.ok) {
      throw new Error(`Kiosk completion failed (${response.status})`);
    }
    return (await response.json()) as KioskTask;
  },
};
