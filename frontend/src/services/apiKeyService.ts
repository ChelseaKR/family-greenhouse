import { api } from './api';

/** Least-privilege scopes a key can carry. Mirrors backend `API_SCOPES`. */
export const API_SCOPES = ['read:plants', 'read:tasks', 'read:activity', 'write:tasks'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Read-only subset — the default selection when issuing a key. Write access
 *  is opt-in only (mirrors backend `READ_API_SCOPES`). */
export const READ_API_SCOPES = ['read:plants', 'read:tasks', 'read:activity'] as const;

/** Scopes that allow mutations; the UI shows a trust warning when selected. */
export const WRITE_API_SCOPES: readonly ApiScope[] = ['write:tasks'];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'read:plants': 'Read plants',
  'read:tasks': 'Read tasks',
  'read:activity': 'Read activity',
  'write:tasks': 'Complete & snooze tasks',
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
