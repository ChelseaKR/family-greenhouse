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

/**
 * Confidence floor for a photo identification, as a probability on the TOP
 * candidate.
 *
 * **This number is a proposal, not a measurement.** It is not derived from a
 * distribution of real Plant.id responses — nobody has looked at one. It is a
 * judgement that below roughly a third, the leading guess among five is more
 * likely wrong than right, so presenting it at the same visual weight as a
 * 0.97 match overstates it. What would change it: a sample of real responses
 * with the accepted species checked against the plant, showing where accepted
 * suggestions actually start going wrong. Until then, treat 0.30 as a placed
 * stake rather than a finding. See issue #344.
 *
 * The floor DEMOTES, it never filters. Dropping low-probability candidates
 * would make an empty list mean both "the model was not confident" and
 * "identification failed", which is the absence-rendered-as-a-value defect
 * this repo keeps finding. Every candidate is still returned and still
 * usable; the caller is told the leading one is weak so it can say so.
 */
export const IDENTIFICATION_CONFIDENCE_FLOOR = 0.3;

/** How many candidates we return, best-first. */
const MAX_SUGGESTIONS = 5;

export interface IdentificationResult {
  configured: true;
  /** Up to five candidates, sorted by probability descending. */
  suggestions: IdentificationSuggestion[];
  /** The floor this response was judged against, so the client renders the
   *  same threshold the server applied instead of hardcoding its own. */
  confidenceFloor: number;
  /**
   * The top candidate scored below `confidenceFloor` — the list is worth
   * showing but not worth trusting.
   *
   * `false` when there are no suggestions at all. That case is "nothing came
   * back", which the caller already reports separately; it is deliberately
   * NOT folded in here, because "no confident match" and "no match" are
   * different things to tell a person.
   */
  lowConfidence: boolean;
}

export interface NotConfiguredResult {
  configured: false;
}

export type IdentifyResponse = IdentificationResult | NotConfiguredResult;

const PLANT_ID_ENDPOINT = 'https://plant.id/api/v3/identification';
const TIMEOUT_MS = 5000;

/** Whether this invocation would consume a paid Plant.id credit. */
export function isPlantIdentificationConfigured(): boolean {
  return Boolean(process.env.PLANT_ID_API_KEY);
}

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
    // Sort BEFORE slicing. Plant.id documents no ordering guarantee, and the
    // bare `.slice(0, 5)` this replaces silently assumed one: an unordered
    // (or differently ordered) response dropped the best match on the floor
    // and handed the user the sixth-best guess as the headline. `.filter()`
    // has already copied the array, so this does not mutate the response.
    // Array#sort is stable, so equal probabilities keep provider order.
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({
      scientificName: s.name,
      commonName: s.details?.common_names?.[0] ?? null,
      probability: s.probability,
    }));

  return {
    configured: true,
    suggestions,
    confidenceFloor: IDENTIFICATION_CONFIDENCE_FLOOR,
    lowConfidence:
      suggestions.length > 0 && suggestions[0].probability < IDENTIFICATION_CONFIDENCE_FLOOR,
  };
}
