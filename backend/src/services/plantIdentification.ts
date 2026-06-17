/**
 * Adapter for Plant.id v3 (kindwise.com). Free tier offers a few hundred
 * identifications/month; if PLANT_ID_API_KEY is unset we return a clear "not
 * configured" signal instead of throwing so the frontend can fall back to
 * manual species entry without a confusing error.
 *
 * Other providers worth considering when this needs to scale:
 *   - PlantNet (free, identification-only, lower accuracy)
 *   - LeafSnap (mobile-only, not ideal for our flow)
 * The interface below is small enough that swapping is trivial.
 */
import { logger } from '../utils/logger.js';

export interface IdentificationSuggestion {
  scientificName: string;
  commonName: string | null;
  probability: number;
}

export interface IdentificationResult {
  configured: true;
  suggestions: IdentificationSuggestion[];
}

export interface NotConfiguredResult {
  configured: false;
}

export type IdentifyResponse = IdentificationResult | NotConfiguredResult;

const PLANT_ID_ENDPOINT = 'https://plant.id/api/v3/identification';
const TIMEOUT_MS = 5000;

interface PlantIdSuggestion {
  name?: string;
  probability?: number;
  details?: {
    common_names?: string[];
  };
}

interface PlantIdResponse {
  result?: {
    classification?: {
      suggestions?: PlantIdSuggestion[];
    };
  };
}

/**
 * Identify a plant from a base64-encoded image. Caller is responsible for
 * resizing the image client-side to keep payloads under the body-size guard.
 */
export async function identifyPlant(base64Image: string): Promise<IdentifyResponse> {
  const apiKey = process.env.PLANT_ID_API_KEY;
  if (!apiKey) return { configured: false };

  // Bound the upstream call so a hung Plant.id connection can't hold the
  // Lambda (and the user) for the full function timeout. Same 5s
  // AbortController pattern as perenual.ts / weather.ts.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${PLANT_ID_ENDPOINT}?details=common_names`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
      },
      body: JSON.stringify({
        images: [base64Image],
        similar_images: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`plant.id timed out after ${TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Log the upstream status + body server-side for debugging, but do NOT
    // reflect Plant.id's error body to the client — it can carry upstream
    // detail we don't want to surface (and the identify handler exposes 5xx
    // messages to the frontend). Return a generic, stable message instead (L2).
    const text = await res.text();
    logger.warn(
      { status: res.status, body: text.slice(0, 500), msg: 'plant_id_upstream_error' },
      'plant_id_upstream_error'
    );
    throw new Error('plant identification service is temporarily unavailable');
  }

  const data = (await res.json()) as PlantIdResponse;
  const raw = data.result?.classification?.suggestions ?? [];
  const suggestions: IdentificationSuggestion[] = raw
    .filter(
      (s): s is Required<Pick<PlantIdSuggestion, 'name' | 'probability'>> & PlantIdSuggestion =>
        typeof s.name === 'string' && typeof s.probability === 'number'
    )
    .slice(0, 5)
    .map((s) => ({
      scientificName: s.name,
      commonName: s.details?.common_names?.[0] ?? null,
      probability: s.probability,
    }));

  return { configured: true, suggestions };
}
