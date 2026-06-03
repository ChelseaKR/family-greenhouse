import { api } from './api';

export type ComponentStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: ComponentStatus;
  version: string;
  checkedAt: string;
  components: {
    database: { status: ComponentStatus };
    auth: { status: ComponentStatus };
    mail: { status: ComponentStatus };
  };
}

export const healthService = {
  async check(): Promise<HealthResponse> {
    const response = await api.get<HealthResponse>('/health');
    return response.data;
  },
};
