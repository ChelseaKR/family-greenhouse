/**
 * Plant Tags client (ADR 0016). Two halves, deliberately separate:
 *
 *   `plantTagService` — the AUTHED management calls (issue / revoke / list /
 *   set PIN) over the shared axios instance, so they carry the session and
 *   the active-household pin like every other member-facing call.
 *
 *   `publicTagService` — the PUBLIC scan calls, over a bare `fetch` against
 *   the same API base (exactly like `sitterService` and `petToxicityService`).
 *   A scanner has no account, so the axios interceptors — which would try to
 *   refresh a session that does not exist — must not run. The 256-bit token
 *   in the path is the only credential; the household PIN, when set, rides in
 *   `X-Tag-Pin` and is verified server-side.
 */
import { api } from './api';

export interface PlantTag {
  id: string;
  householdId: string;
  plantId: string;
  plantName: string;
  plantSpecies: string | null;
  plantStatus: 'active' | 'died' | 'gave_away' | 'archived';
  createdBy: string;
  createdAt: string;
  status: 'active' | 'revoked';
  revokedAt: string | null;
  /** The secret the QR code encodes. Present because the household prints it. */
  token: string;
  /** The scan URL the QR code encodes. */
  url: string;
}

export interface PlantTagAllowance {
  enabled: boolean;
  /** null means unlimited (Infinity does not survive JSON). */
  max: number | null;
  used: number;
}

export interface PlantTagsResponse {
  tags: PlantTag[];
  pinEnabled: boolean;
  allowance: PlantTagAllowance;
  planId: 'seedling' | 'garden' | 'greenhouse';
}

export const plantTagService = {
  async list(householdId: string): Promise<PlantTagsResponse> {
    const response = await api.get<PlantTagsResponse>(`/households/${householdId}/plant-tags`);
    return response.data;
  },

  async issue(plantId: string): Promise<PlantTag> {
    const response = await api.post<PlantTag>(`/plants/${plantId}/tag`);
    return response.data;
  },

  async revoke(plantId: string): Promise<void> {
    await api.delete(`/plants/${plantId}/tag`);
  },

  async setPin(householdId: string, pin: string | null): Promise<{ pinEnabled: boolean }> {
    const response = await api.put<{ pinEnabled: boolean }>(
      `/households/${householdId}/plant-tags/pin`,
      { pin }
    );
    return response.data;
  },
};

// --- Public scan surface ----------------------------------------------------

/** One completion as the scan page shows it. */
export interface TagCare {
  taskType: string;
  completedAt: string;
  completedByName: string;
  viaTag: boolean;
}

/**
 * Settled read (ADR 0010). `unavailable` is the honest answer when the care
 * history could not be read — the page says so instead of rendering the
 * absence of data as "never watered".
 */
export type TagHistory =
  | { status: 'ok'; lastCare: TagCare | null; lastWatered: TagCare | null }
  | { status: 'unavailable' };

export interface TagDueTask {
  taskId: string;
  taskType: string;
  dueDate: string;
  overdue: boolean;
}

export interface TagView {
  plantName: string;
  species: string | null;
  imageUrl: string | null;
  /** The household's care conventions for this plant ("we bottom-water it"). */
  careNotes: string | null;
  history: TagHistory;
  tasks: TagDueTask[];
}

export interface TagCompletion {
  taskId: string;
  taskType: string;
  dueDate: string;
  completedByName: string;
  /** True when this occurrence had already been completed (a retried tap). */
  alreadyDone: boolean;
}

/** The tag is unknown, revoked, or its plant is no longer being cared for. */
export class TagInactiveError extends Error {
  constructor() {
    super('This plant tag is no longer active.');
    this.name = 'TagInactiveError';
  }
}

/** The household set a PIN. `wrong` distinguishes a bad guess from a first ask. */
export class TagPinError extends Error {
  constructor(readonly reason: 'required' | 'wrong') {
    super('This plant tag needs the household PIN.');
    this.name = 'TagPinError';
  }
}

/** Too many wrong PINs on this tag. */
export class TagLockedError extends Error {
  constructor(readonly lockedUntil: string | null) {
    super('Too many wrong PINs.');
    this.name = 'TagLockedError';
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

interface ErrorBody {
  message?: string;
  details?: { pinRequired?: boolean; reason?: string; lockedUntil?: string };
}

async function throwForStatus(response: Response): Promise<never> {
  if (response.status === 404 || response.status === 410) throw new TagInactiveError();
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A non-JSON error body is still an error; fall through to the generic one.
  }
  if (response.status === 423) throw new TagLockedError(body.details?.lockedUntil ?? null);
  if (response.status === 401) {
    throw new TagPinError(body.details?.reason === 'wrong' ? 'wrong' : 'required');
  }
  throw new Error(`Plant tag request failed (${response.status})`);
}

function pinHeaders(pin?: string): Record<string, string> {
  return pin ? { 'X-Tag-Pin': pin } : {};
}

export const publicTagService = {
  async getView(token: string, pin?: string, signal?: AbortSignal): Promise<TagView> {
    const response = await fetch(`${API_URL}/tag/${encodeURIComponent(token)}`, {
      signal,
      headers: { Accept: 'application/json', ...pinHeaders(pin) },
    });
    if (!response.ok) await throwForStatus(response);
    return (await response.json()) as TagView;
  },

  async completeTask(args: {
    token: string;
    taskId: string;
    displayName: string;
    expectedNextDue?: string;
    pin?: string;
  }): Promise<TagCompletion> {
    const response = await fetch(
      `${API_URL}/tag/${encodeURIComponent(args.token)}/tasks/${encodeURIComponent(args.taskId)}/complete`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...pinHeaders(args.pin),
        },
        body: JSON.stringify({
          displayName: args.displayName,
          expectedNextDue: args.expectedNextDue,
        }),
      }
    );
    if (!response.ok) await throwForStatus(response);
    return (await response.json()) as TagCompletion;
  },
};

/** Remember the scanner's name on this device so Grandma types it once. */
export const TAG_NAME_STORAGE_KEY = 'fg.tagDisplayName';
