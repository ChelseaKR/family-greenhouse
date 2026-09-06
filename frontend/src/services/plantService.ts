import axios from 'axios';
import { api } from './api';
import { track } from './analytics';
import type { IdentifyCreditBalance } from './billingService';

export type PlantStatus = 'active' | 'died' | 'gave_away' | 'archived';

/** List filter mirroring the backend: active (default), past, or all. */
export type PlantFilter = 'active' | 'past' | 'all';

/** Care rotation for a space (ADR 0018); mirrors the backend SpaceRotation. */
export interface SpaceRotation {
  memberIds: string[];
  cadence: 'weekly' | 'monthly';
  anchor: string;
}

export interface PlantSpace {
  id: string;
  householdId: string;
  name: string;
  environment: 'inside' | 'outside';
  /** Whether rain reaches plants here. Older outdoor spaces are treated as exposed. */
  rainExposure?: 'exposed' | 'sheltered';
  /** Approximate ambient light; absent/null until the household assesses it. */
  lightLevel?: 'low' | 'medium' | 'bright' | null;
  /** Whether household pets can reach plants in this space. */
  petAccess?: boolean | null;
  /** Household member who usually handles new tasks for plants here. */
  defaultCaregiverId?: string | null;
  /** Care rotation; takes precedence over defaultCaregiverId. */
  rotation?: SpaceRotation | null;
  /**
   * Derived server-side, present ONLY on spaces that have a rotation.
   * `turnUserId: null` means everyone in the rotation is away — a real
   * answer, and rendered as one rather than as "no rotation".
   */
  rotationTurn?: { turnUserId: string | null; turnName: string | null };
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** House rule length cap; mirrors CARE_RULE_MAX_LENGTH in backend/src/models/schemas.ts. */
export const CARE_RULE_MAX_LENGTH = 140;

/** Mirrors SpeciesSource in backend/src/models/types.ts. */
export type SpeciesSource = 'user' | 'identified' | 'catalog';

export interface Plant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  spaceId?: string | null;
  placementNote?: string | null;
  summerSpaceId?: string | null;
  winterSpaceId?: string | null;
  imageUrl: string | null;
  notes: string | null;
  /** House rule: one short care convention (≤140 chars) shown at completion
   *  time. Absent/null on rows without one — nothing is rendered then. */
  careRule?: string | null;
  /** Lifecycle status; legacy rows may omit it → treat as 'active'. */
  status?: PlantStatus;
  statusChangedAt?: string | null;
  tags?: string[];
  perenualSpeciesId?: number | null;
  /**
   * Where `species` came from. Server-derived (a client cannot set it):
   * `identified` means a photo-identification guess the user accepted, so the
   * care advice keyed off this species — watering, light, pet toxicity —
   * inherits the model's uncertainty. Null/absent = unknown, which is what
   * every plant added before this field carried.
   */
  speciesSource?: SpeciesSource | null;
  /** Propagation lineage: the same-household plant this was cut from. */
  parentPlantId?: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface CreatePlantData {
  name: string;
  species?: string;
  location?: string;
  spaceId?: string;
  placementNote?: string;
  summerSpaceId?: string;
  winterSpaceId?: string;
  notes?: string;
  careRule?: string;
  tags?: string[];
  perenualSpeciesId?: number;
  /**
   * The scientific name this write says came from a photo identification the
   * user accepted. The server derives `speciesSource` from it and only
   * believes it when it names the species actually being written — the enum
   * itself is not settable from here.
   */
  identifiedSpecies?: string;
  /** Set when adding a cutting via "Propagate" — links it to its parent. */
  parentPlantId?: string;
}

export interface UpdatePlantData {
  name?: string;
  species?: string;
  location?: string;
  spaceId?: string | null;
  placementNote?: string | null;
  summerSpaceId?: string | null;
  winterSpaceId?: string | null;
  notes?: string;
  /** null clears the rule; omit to leave it untouched. */
  careRule?: string | null;
  tags?: string[];
  perenualSpeciesId?: number | null;
  /**
   * The scientific name this write says came from a photo identification the
   * user accepted. The server derives `speciesSource` from it and only
   * believes it when it names the species actually being written — the enum
   * itself is not settable from here.
   */
  identifiedSpecies?: string;
  status?: PlantStatus;
}

/** One node in a plant's propagation lineage. */
export interface LineageEntry {
  id: string;
  name: string;
  status: PlantStatus;
}

export interface PlantLineage {
  /** The plant this one was cut from (omitted if none / hard-deleted). */
  parent?: LineageEntry;
  /** Cuttings taken from this plant, oldest first — died ones included. */
  children: Array<LineageEntry & { createdAt: string }>;
}

/**
 * How many completions `GET /plants/{id}` returns in `recentCompletions`.
 * Mirrors `RECENT_COMPLETIONS_LIMIT` in
 * `backend/src/handlers/plants/handler.ts` (and the matching slice in
 * `backend/src/local-server.ts`); change both together.
 *
 * Anything computed from `recentCompletions` — counts, streaks — is bounded
 * by this number and must be labelled with the window rather than presented
 * as a lifetime figure.
 */
export const RECENT_COMPLETIONS_LIMIT = 10;

export interface PlantWithTasks extends Plant {
  upcomingTasks: Task[];
  /** The most recent `RECENT_COMPLETIONS_LIMIT` completions across all of
   *  this plant's tasks — NOT the full history. */
  recentCompletions: TaskCompletion[];
  lineage?: PlantLineage;
}

/** Response of POST /plants/{id}/share. */
export interface PlantShareLink {
  code: string;
  url: string;
  expiresAt: string;
}

/** Public share preview (GET /plants/shared/{code} — no auth). */
export interface SharedPlantPreview {
  plant: {
    name: string;
    species: string | null;
    notes: string | null;
    imageUrl: string | null;
    tags: string[];
  };
  householdName: string;
  expiresAt: string;
}

export interface Task {
  id: string;
  plantId: string;
  plantName: string;
  type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';
  customType?: string;
  frequency: number; // days
  lastCompleted: string | null;
  nextDue: string;
  assignedTo: string | null;
  assignedToName: string | null;
  /** Inherited assignments — space default, Move Day split, or rotation turn
   *  — can be taken over by another member; null means explicit or
   *  unassigned. */
  assignmentSource?: 'space_default' | 'move_day' | 'rotation' | null;
  notes: string | null;
  /** Auto-handoff marker: `escalatedForDue === nextDue` means this occurrence
   *  was put up for grabs by the app and nobody has claimed it since. */
  escalatedAt?: string | null;
  escalatedForDue?: string | null;
  escalatedFrom?: string | null;
  /** "Ask family to do it" marker (ADR 0024): `helpAskedForDue === nextDue`
   *  AND nobody assigned means a housemate asked for this occurrence and it
   *  is still waiting. Claiming or completing it closes the ask by itself —
   *  there is no separate cancel. */
  helpAskedAt?: string | null;
  helpAskedBy?: string | null;
  helpAskedByName?: string | null;
  helpAskedNote?: string | null;
  helpAskedForDue?: string | null;
  createdBy: string;
  createdAt: string;
}

export interface TaskCompletion {
  id: string;
  taskId: string;
  taskType: string;
  completedBy: string;
  completedByName: string;
  completedAt: string;
  notes: string | null;
}

/** One task definition riding along with a bulk-imported plant. */
export interface ImportTaskData {
  type: Task['type'];
  customType?: string;
  frequency: number;
  assignedTo?: string;
  notes?: string;
}

/** One plant row in a POST /plants/import request (max 100 per call). */
export interface ImportPlantData {
  name: string;
  species?: string;
  location?: string;
  notes?: string;
  tags?: string[];
  /** From an export round-trip; the backend persists it when present. */
  perenualSpeciesId?: number | null;
  /** Accepted for export round-trips; not persisted server-side (yet). */
  acquiredAt?: string;
  tasks?: ImportTaskData[];
}

export interface ImportRowResult {
  index: number;
  status: 'created' | 'skipped';
  plantId?: string;
  error?: string;
}

export interface ImportPlantsResponse {
  results: ImportRowResult[];
  created: number;
  skipped: number;
  planLimitHit: boolean;
}

export interface ImageUploadResponse {
  uploadUrl: string;
  imageUrl: string;
}

export interface PlantPhoto {
  id: string;
  plantId: string;
  imageUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  caption: string | null;
}

export const plantService = {
  async getPlants(filter: PlantFilter = 'active'): Promise<Plant[]> {
    const response = await api.get<Plant[]>('/plants', { params: { filter } });
    return response.data;
  },

  /** Archive, record an outcome, or restore a plant to active care. */
  async setPlantStatus(id: string, status: PlantStatus): Promise<Plant> {
    const response = await api.put<Plant>(`/plants/${id}`, { status });
    track('plant_lifecycle_changed', { context: status });
    return response.data;
  },

  async getPlant(id: string): Promise<PlantWithTasks> {
    const response = await api.get<PlantWithTasks>(`/plants/${id}`);
    return response.data;
  },

  async createPlant(data: CreatePlantData): Promise<Plant> {
    const response = await api.post<Plant>('/plants', data);
    return response.data;
  },

  /**
   * Bulk import (max 100 plants per call — the page batches larger files).
   * Partial success by contract: a 200 may still carry skipped rows, and
   * `planLimitHit` flags that the household's plan cap stopped the batch.
   */
  async importPlants(plants: ImportPlantData[]): Promise<ImportPlantsResponse> {
    const response = await api.post<ImportPlantsResponse>('/plants/import', { plants });
    // This is a success event, not an attempt event: failed imports should not
    // inflate activation telemetry. Use the server-confirmed created count
    // because the import contract permits partial success.
    track('plants_imported', { context: String(response.data.created) });
    return response.data;
  },

  async updatePlant(id: string, data: UpdatePlantData): Promise<Plant> {
    const response = await api.put<Plant>(`/plants/${id}`, data);
    return response.data;
  },

  async movePlants(input: {
    plantIds: string[];
    spaceId: string | null;
    placementNote?: string | null;
  }): Promise<Plant[]> {
    const response = await api.post<Plant[]>('/plants/move', input);
    track('plants_moved', { context: String(input.plantIds.length) });
    return response.data;
  },

  async deletePlant(id: string): Promise<void> {
    await api.delete(`/plants/${id}`);
  },

  /**
   * Presign an image upload. `contentType` must be one of image/jpeg,
   * image/png, image/webp and MUST match the Content-Type header of the
   * subsequent PUT — the backend signs the URL against it.
   */
  async getImageUploadUrl(plantId: string, contentType: string): Promise<ImageUploadResponse> {
    const response = await api.post<ImageUploadResponse>(`/plants/${plantId}/image`, {
      contentType,
    });
    return response.data;
  },

  async uploadImage(
    uploadUrl: string,
    blob: Blob,
    contentType: string,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    // We use XMLHttpRequest rather than fetch because fetch lacks built-in
    // upload-progress events; if the user is uploading a multi-megabyte image
    // over a slow connection we want to show a progress bar.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      // Must match the contentType the presign request was made with.
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(event.loaded / event.total);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed with status ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      // Abort the in-flight PUT when the caller cancels (e.g. unmount) so an
      // abandoned upload doesn't run to completion and confirm server-side.
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(blob);
    });
  },

  async confirmImageUpload(plantId: string, imageUrl: string): Promise<{ imageUrl: string }> {
    const response = await api.post<{ imageUrl: string }>(`/plants/${plantId}/image/confirm`, {
      imageUrl,
    });
    track('photo_uploaded');
    return response.data;
  },

  async getPlantHistory(plantId: string): Promise<TaskCompletion[]> {
    const response = await api.get<TaskCompletion[]>(`/plants/${plantId}/history`);
    return response.data;
  },

  async listPhotos(plantId: string): Promise<PlantPhoto[]> {
    const response = await api.get<PlantPhoto[]>(`/plants/${plantId}/photos`);
    return response.data;
  },

  async identifyPlant(imageBase64: string): Promise<IdentifyResponse> {
    const response = await api.post<IdentifyResponse>('/plants/identify', {
      image: imageBase64,
    });
    return response.data;
  },

  /**
   * Leaf-health check: send a (downscaled!) photo as a data URL / base64
   * string and get back a strict visual assessment. Same transport and body
   * cap as identify — downscale before calling, never the raw camera file.
   */
  async checkLeafHealth(plantId: string, imageBase64: string): Promise<LeafHealthResult> {
    const response = await api.post<LeafHealthResult>(`/plants/${plantId}/health-check`, {
      imageBase64,
    });
    track('leaf_health_checked');
    return response.data;
  },

  /** Mint a 14-day share link for a plant card (any member may share). */
  async sharePlant(id: string): Promise<PlantShareLink> {
    const response = await api.post<PlantShareLink>(`/plants/${id}/share`);
    track('plant_shared');
    return response.data;
  },

  /** Public share preview — works logged-out (the route has no auth). */
  async getSharedPlant(code: string): Promise<SharedPlantPreview> {
    const response = await api.get<SharedPlantPreview>(`/plants/shared/${code}`);
    return response.data;
  },

  /** Copy a shared cutting card into the caller's household (plan cap → 402). */
  async acceptSharedPlant(code: string): Promise<Plant> {
    const response = await api.post<Plant>(`/plants/shared/${code}/accept`);
    track('plant_share_accepted');
    return response.data;
  },
};

export interface IdentificationSuggestion {
  scientificName: string;
  commonName: string | null;
  probability: number;
}

/** Mirrors the `usage` block of POST /plants/identify. `used` is null when the
 *  server could not read its counter — unknown, never zero. `source` and
 *  `credits` appear only on the enforced path (ADR 0019). */
export interface IdentifyUsage {
  used: number | null;
  allowance: number;
  meteringEnabled: boolean;
  source?: 'allowance' | 'credit';
  credits?: IdentifyCreditBalance;
}

export interface IdentifyResponse {
  configured: boolean;
  /** Best-first: the server sorts by probability before truncating to five. */
  suggestions?: IdentificationSuggestion[];
  /** Probability the top candidate is judged against (server-set). */
  confidenceFloor?: number;
  /**
   * The top candidate scored below `confidenceFloor`. The list is still
   * returned in full and every candidate stays usable — the floor demotes, it
   * never filters, so an empty list keeps meaning exactly one thing ("nothing
   * came back") instead of also meaning "not confident enough to say".
   */
  lowConfidence?: boolean;
  usage?: IdentifyUsage;
}

/**
 * The 402 POST /plants/identify answers once the month's allowance AND any
 * top-up credits are spent. `topUp` is the pack on offer (null when it
 * cannot be bought here: no household, payments paused, or no price
 * configured); `credits` is the balance the refusal saw — a real 0, or null
 * when credits were not consulted.
 */
export interface IdentifyBudgetExhausted {
  message: string;
  topUpAvailable: boolean;
  credits: IdentifyCreditBalance | null;
  topUp: { credits: number; priceUsd: number | null } | null;
}

/**
 * Recognise the budget-exhausted refusal from any thrown error, so the
 * caller can offer the pack instead of a generic failure. Anything that is
 * not exactly that contract — a different status, a missing code — is null,
 * and the caller falls back to `getErrorMessage`.
 */
export function identifyBudgetExhaustedFromError(error: unknown): IdentifyBudgetExhausted | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 402) return null;
  const data = error.response.data as
    { message?: unknown; details?: Record<string, unknown> | null } | null | undefined;
  const details = data?.details;
  if (!details || details.code !== 'IDENTIFY_BUDGET_EXHAUSTED') return null;
  const rawCredits = details.credits as { remaining?: unknown; expiresAt?: unknown } | null;
  const credits =
    rawCredits && typeof rawCredits.remaining === 'number'
      ? {
          remaining: rawCredits.remaining,
          expiresAt: typeof rawCredits.expiresAt === 'string' ? rawCredits.expiresAt : null,
        }
      : null;
  const rawTopUp = details.topUp as { credits?: unknown; priceUsd?: unknown } | null;
  const topUp =
    rawTopUp && typeof rawTopUp.credits === 'number'
      ? {
          credits: rawTopUp.credits,
          priceUsd: typeof rawTopUp.priceUsd === 'number' ? rawTopUp.priceUsd : null,
        }
      : null;
  return {
    message: typeof data?.message === 'string' ? data.message : '',
    topUpAvailable: details.topUpAvailable === true && topUp !== null,
    credits,
    topUp,
  };
}

/** Mirrors backend services/leafHealth.ts LeafHealthAssessment. */
export type LeafHealthOverall = 'healthy' | 'monitor' | 'concern';
export type LeafHealthConfidence = 'low' | 'medium' | 'high';

export interface LeafHealthObservation {
  sign: string;
  confidence: LeafHealthConfidence;
  note: string;
}

export interface LeafHealthResult {
  overall: LeafHealthOverall;
  observations: LeafHealthObservation[];
  suggestion: string;
  disclaimer: string;
  /** True when the server returned the canned fallback (no Bedrock access). */
  demo?: boolean;
}
