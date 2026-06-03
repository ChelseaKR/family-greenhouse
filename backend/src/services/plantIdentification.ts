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

  const res = await fetch(`${PLANT_ID_ENDPOINT}?details=common_names`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
    },
    body: JSON.stringify({
      images: [base64Image],
      similar_images: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`plant.id ${res.status}: ${text.slice(0, 200)}`);
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
