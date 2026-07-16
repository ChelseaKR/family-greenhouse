import { api } from './api';
import { track } from './analytics';

export type PlantStatus = 'active' | 'died' | 'gave_away' | 'archived';

/** List filter mirroring the backend: active (default), past, or all. */
export type PlantFilter = 'active' | 'past' | 'all';

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
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

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
  /** Lifecycle status; legacy rows may omit it → treat as 'active'. */
  status?: PlantStatus;
  statusChangedAt?: string | null;
  tags?: string[];
  perenualSpeciesId?: number | null;
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
  tags?: string[];
  perenualSpeciesId?: number;
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
  tags?: string[];
  perenualSpeciesId?: number | null;
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

export interface PlantWithTasks extends Plant {
  upcomingTasks: Task[];
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
  notes: string | null;
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
    track('plants_imported', { context: String(plants.length) });
    const response = await api.post<ImportPlantsResponse>('/plants/import', { plants });
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
    track('photo_uploaded');
    const response = await api.post<{ imageUrl: string }>(`/plants/${plantId}/image/confirm`, {
      imageUrl,
    });
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
    track('leaf_health_checked');
    const response = await api.post<LeafHealthResult>(`/plants/${plantId}/health-check`, {
      imageBase64,
    });
    return response.data;
  },

  /** Mint a 14-day share link for a plant card (any member may share). */
  async sharePlant(id: string): Promise<PlantShareLink> {
    track('plant_shared');
    const response = await api.post<PlantShareLink>(`/plants/${id}/share`);
    return response.data;
  },

  /** Public share preview — works logged-out (the route has no auth). */
  async getSharedPlant(code: string): Promise<SharedPlantPreview> {
    const response = await api.get<SharedPlantPreview>(`/plants/shared/${code}`);
    return response.data;
  },

  /** Copy a shared cutting card into the caller's household (plan cap → 402). */
  async acceptSharedPlant(code: string): Promise<Plant> {
    track('plant_share_accepted');
    const response = await api.post<Plant>(`/plants/shared/${code}/accept`);
    return response.data;
  },
};

export interface IdentificationSuggestion {
  scientificName: string;
  commonName: string | null;
  probability: number;
}

export interface IdentifyResponse {
  configured: boolean;
  suggestions?: IdentificationSuggestion[];
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
