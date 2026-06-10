import { api } from './api';
import { track } from './analytics';

export type PlantStatus = 'active' | 'died' | 'gave_away';

/** List filter mirroring the backend: active (default), past, or all. */
export type PlantFilter = 'active' | 'past' | 'all';

export interface Plant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  imageUrl: string | null;
  notes: string | null;
  /** Lifecycle status; legacy rows may omit it → treat as 'active'. */
  status?: PlantStatus;
  statusChangedAt?: string | null;
  tags?: string[];
  perenualSpeciesId?: number | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface CreatePlantData {
  name: string;
  species?: string;
  location?: string;
  notes?: string;
  tags?: string[];
  perenualSpeciesId?: number;
}

export interface UpdatePlantData {
  name?: string;
  species?: string;
  location?: string;
  notes?: string;
  tags?: string[];
  perenualSpeciesId?: number | null;
  status?: PlantStatus;
}

export interface PlantWithTasks extends Plant {
  upcomingTasks: Task[];
  recentCompletions: TaskCompletion[];
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

  /** Record a lifecycle outcome (died / gave_away) or restore to active. */
  async setPlantStatus(id: string, status: PlantStatus): Promise<Plant> {
    const response = await api.put<Plant>(`/plants/${id}`, { status });
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

  async updatePlant(id: string, data: UpdatePlantData): Promise<Plant> {
    const response = await api.put<Plant>(`/plants/${id}`, data);
    return response.data;
  },

  async deletePlant(id: string): Promise<void> {
    await api.delete(`/plants/${id}`);
  },

  async getImageUploadUrl(plantId: string): Promise<ImageUploadResponse> {
    const response = await api.post<ImageUploadResponse>(`/plants/${plantId}/image`);
    return response.data;
  },

  async uploadImage(
    uploadUrl: string,
    file: File,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    // We use XMLHttpRequest rather than fetch because fetch lacks built-in
    // upload-progress events; if the user is uploading a multi-megabyte image
    // over a slow connection we want to show a progress bar.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type);
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
      xhr.send(file);
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
