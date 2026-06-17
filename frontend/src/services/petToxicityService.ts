/**
 * Client for the public pet-toxicity lookup (GET /species/toxicity).
 *
 * This endpoint is unauthenticated by design — it powers the logged-out
 * "is this plant safe for pets?" page — so we call it with a bare `fetch`
 * against the same API base the axios client uses, rather than the shared
 * `api` instance. That deliberately skips the auth-header + 401-refresh
 * interceptors, which would otherwise try to refresh a (non-existent) session
 * for an anonymous visitor.
 */

export type ToxicityVerdict = 'toxic' | 'non-toxic';

export interface ToxicityMatch {
  slug: string;
  commonName: string;
  scientificName: string;
  cats: ToxicityVerdict;
  dogs: ToxicityVerdict;
  note: string;
}

interface ToxicityResponse {
  query: string;
  results: ToxicityMatch[];
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const petToxicityService = {
  async lookup(query: string, signal?: AbortSignal): Promise<ToxicityMatch[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const url = `${API_URL}/species/toxicity?q=${encodeURIComponent(q)}`;
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Toxicity lookup failed (${response.status})`);
    }
    const data = (await response.json()) as ToxicityResponse;
    return Array.isArray(data.results) ? data.results : [];
  },
};
