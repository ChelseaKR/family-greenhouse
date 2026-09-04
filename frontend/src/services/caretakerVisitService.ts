/**
 * Client for the PUBLIC caretaker endpoints (GET /caretaker/{token} and the
 * three actions a caretaker may take).
 *
 * Unauthenticated by design — a caretaker opens a time-boxed link and never
 * signs in — so we call with a bare `fetch` against the same API base the
 * axios client uses, exactly like `sitterService`. That deliberately skips the
 * auth-header + 401-refresh interceptors, which would otherwise try to refresh
 * a session that does not exist.
 *
 * The 256-bit token in the path is the only credential. The endpoints expose
 * no member identity, private notes, or household climate location, and the
 * caretaker can do exactly three things: complete a task, add a note, add a
 * photo.
 */

export interface CaretakerTask {
  taskId: string;
  /** Opaque plant id — the caretaker's photo routes are scoped by it. */
  plantId: string;
  plantName: string;
  taskType: string;
  dueDate: string;
  spaceName: string | null;
  placementNote: string | null;
  overdue: boolean;
}

export interface CaretakerView {
  /** The name the household gave this seat; every action is logged under it. */
  caretakerName: string;
  startsAt: string;
  expiresAt: string;
  permissions: string[];
  tasks: CaretakerTask[];
}

export interface CaretakerCompletion {
  taskId: string;
  plantName: string;
  taskType: string;
  dueDate: string;
  overdue: boolean;
  /** False when the task completed but its line on the visit record did not
   *  save. Surfaced rather than swallowed — the record is the product. */
  visitRecorded: boolean;
}

export interface CaretakerNote {
  text: string;
  at: string;
  visitRecorded: boolean;
}

export interface CaretakerPhotoConfirmation {
  imageUrl: string;
  visitRecorded: boolean;
}

/** Thrown when the seat is missing/expired/revoked (404) so the page can show
 *  a friendly "this link is no longer active" message, not a raw error. */
export class CaretakerLinkInactiveError extends Error {
  constructor() {
    super('This caretaker link is invalid or has expired.');
    this.name = 'CaretakerLinkInactiveError';
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (response.status === 404 || response.status === 410) {
    throw new CaretakerLinkInactiveError();
  }
  if (!response.ok) {
    throw new Error(`Caretaker request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export const caretakerVisitService = {
  async getView(token: string, signal?: AbortSignal): Promise<CaretakerView> {
    return request<CaretakerView>(`/caretaker/${encodeURIComponent(token)}`, { signal });
  },

  async completeTask(
    token: string,
    taskId: string,
    expectedNextDue: string
  ): Promise<CaretakerCompletion> {
    return request<CaretakerCompletion>(
      `/caretaker/${encodeURIComponent(token)}/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedNextDue }),
      }
    );
  },

  async addNote(token: string, text: string): Promise<CaretakerNote> {
    return request<CaretakerNote>(`/caretaker/${encodeURIComponent(token)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  },

  /**
   * Two-step photo add, the same contract members use: ask for a presigned
   * PUT, upload straight to storage, then confirm so the server can verify the
   * object before attaching it to the plant.
   */
  async addPhoto(token: string, plantId: string, file: File): Promise<CaretakerPhotoConfirmation> {
    const contentType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      ? file.type
      : 'image/jpeg';
    const grant = await request<{ uploadUrl: string; imageUrl: string }>(
      `/caretaker/${encodeURIComponent(token)}/plants/${encodeURIComponent(plantId)}/photo`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType }),
      }
    );

    const upload = await fetch(grant.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
    });
    if (!upload.ok) {
      throw new Error(`Photo upload failed (${upload.status})`);
    }

    return request<CaretakerPhotoConfirmation>(
      `/caretaker/${encodeURIComponent(token)}/plants/${encodeURIComponent(plantId)}/photo/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: grant.imageUrl }),
      }
    );
  },
};
