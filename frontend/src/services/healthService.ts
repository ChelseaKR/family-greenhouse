import { api } from './api';

export type OverallStatus = 'ok' | 'degraded' | 'down';
export type ComponentStatus = OverallStatus | 'error' | 'unknown';

export interface HealthResponse {
  status: OverallStatus;
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
