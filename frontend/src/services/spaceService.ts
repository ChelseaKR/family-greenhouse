import { api } from './api';
import type { PlantSpace } from './plantService';

export const spaceService = {
  async getSpaces(): Promise<PlantSpace[]> {
    const response = await api.get<PlantSpace[]>('/spaces');
    return response.data;
  },

  async createSpace(input: {
    name: string;
    environment: PlantSpace['environment'];
    rainExposure?: PlantSpace['rainExposure'];
  }): Promise<PlantSpace> {
    const response = await api.post<PlantSpace>('/spaces', input);
    return response.data;
  },

  async updateSpace(
    id: string,
    input: Partial<Pick<PlantSpace, 'name' | 'environment' | 'rainExposure'>>
  ): Promise<PlantSpace> {
    const response = await api.put<PlantSpace>(`/spaces/${id}`, input);
    return response.data;
  },

  async deleteSpace(id: string): Promise<void> {
    await api.delete(`/spaces/${id}`);
  },
};
