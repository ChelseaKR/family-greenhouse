import { api } from './api';

/** Least-privilege read scopes a key can carry. Mirrors backend `API_SCOPES`. */
export const API_SCOPES = ['read:plants', 'read:tasks', 'read:activity'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'read:plants': 'Read plants',
  'read:tasks': 'Read tasks',
  'read:activity': 'Read activity',
};

export interface ApiKeyRecord {
  id: string;
  householdId: string;
  label: string;
  last4: string;
  scopes: ApiScope[];
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
}

export interface ApiKeyCreateResult {
  record: ApiKeyRecord;
  plaintext: string;
}

export const apiKeyService = {
  async list(): Promise<ApiKeyRecord[]> {
    const response = await api.get<ApiKeyRecord[]>('/api-keys');
    return response.data;
  },

  async create(label: string, scopes?: ApiScope[]): Promise<ApiKeyCreateResult> {
    const response = await api.post<ApiKeyCreateResult>('/api-keys', { label, scopes });
    return response.data;
  },

  async revoke(id: string): Promise<void> {
    await api.delete(`/api-keys/${id}`);
  },
};
