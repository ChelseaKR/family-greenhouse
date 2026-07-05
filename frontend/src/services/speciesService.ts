import { api } from './api';

export interface PerenualSpeciesSummary {
  id: number;
  commonName: string;
  scientificName: string;
  thumbnailUrl: string | null;
}

export interface PerenualSpeciesDetail extends PerenualSpeciesSummary {
  family: string | null;
  cycle: string | null;
  watering: 'frequent' | 'average' | 'minimum' | 'none' | null;
  sunlight: string[];
  hardinessZone: string | null;
  indoor: boolean;
  edible: boolean;
  // `null` means Perenual has no toxicity data for this species — distinct
  // from a confirmed `false`. Never render an absence of data as "confirmed
  // safe."
  poisonousToPets: boolean | null;
  defaultImageUrl: string | null;
}

export type SpeciesSearchResponse = {
  // 'disabled' = no Perenual API key configured. 'unavailable' = configured
  // but this request got no data (budget exhausted or a transient upstream
  // error) — a real, possibly-transient outage, not the same as "off".
  source: 'perenual' | 'disabled' | 'unavailable';
  results: PerenualSpeciesSummary[];
};

export interface CareSuggestion {
  wateringDays: number | null;
  sunlight: string[];
  summary: string;
}

export interface CareGuideSection {
  type: 'watering' | 'sunlight' | 'pruning';
  description: string;
}

export interface CareGuideResponse {
  commonName: string;
  scientificName: string;
  family: string | null;
  cycle: string | null;
  hardinessZone: string | null;
  indoor: boolean;
  poisonousToPets: boolean | null;
  sunlight: string[];
  sections: CareGuideSection[];
}

export const speciesService = {
  async search(query: string): Promise<SpeciesSearchResponse> {
    const response = await api.get<SpeciesSearchResponse>('/species/search', {
      params: { q: query },
    });
    return response.data;
  },

  async detail(id: number): Promise<PerenualSpeciesDetail | null> {
    const response = await api.get<{ result: PerenualSpeciesDetail | null }>(`/species/${id}`);
    return response.data.result;
  },

  async careSuggestions(id: number): Promise<CareSuggestion | null> {
    const response = await api.get<{ result: CareSuggestion | null }>(
      `/species/${id}/care-suggestions`
    );
    return response.data.result;
  },

  async careGuide(id: number): Promise<CareGuideResponse | null> {
    const response = await api.get<{ result: CareGuideResponse | null }>(`/species/${id}/guide`);
    return response.data.result;
  },
};
