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

import { asPetVerdict, type PetVerdict } from '@/features/petsafe/petVerdict';

/**
 * `unknown`: the table cannot cite a verdict for that animal. Render it only
 * through features/petsafe/petVerdict.ts, never with a `=== 'toxic'` ternary.
 */
export type ToxicityVerdict = PetVerdict;

export interface ToxicityMatch {
  slug: string;
  commonName: string;
  scientificName: string;
  cats: ToxicityVerdict;
  dogs: ToxicityVerdict;
  /** The table's note; null when any animal is unknown (nothing cites it). */
  note: string | null;
}

/**
 * The opt-in that tells the API this bundle renders `unknown` safely. Without
 * it the API answers in legacy mode, for old bundles (including native builds
 * a web deploy cannot update) that would show `unknown` as "Non-toxic". See
 * VerdictMode in backend/src/models/petToxicity.ts.
 */
export const UNKNOWN_VERDICT_OPT_IN = 'unknown=1';

/** Whatever the wire says, only the literal verdicts survive. */
export function normalizeToxicityMatch(raw: unknown): ToxicityMatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.slug !== 'string' || typeof m.commonName !== 'string') return null;
  const cats = asPetVerdict(m.cats);
  const dogs = asPetVerdict(m.dogs);
  const cited = cats !== 'unknown' && dogs !== 'unknown';
  return {
    slug: m.slug,
    commonName: m.commonName,
    scientificName: typeof m.scientificName === 'string' ? m.scientificName : '',
    cats,
    dogs,
    note: cited && typeof m.note === 'string' && m.note.trim() ? m.note : null,
  };
}

interface ToxicityResponse {
  query: string;
  results: unknown[];
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const petToxicityService = {
  async lookup(query: string, signal?: AbortSignal): Promise<ToxicityMatch[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const url = `${API_URL}/species/toxicity?q=${encodeURIComponent(q)}&${UNKNOWN_VERDICT_OPT_IN}`;
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Toxicity lookup failed (${response.status})`);
    }
    const data = (await response.json()) as ToxicityResponse;
    return Array.isArray(data.results)
      ? data.results.map(normalizeToxicityMatch).filter((m): m is ToxicityMatch => m !== null)
      : [];
  },
};
