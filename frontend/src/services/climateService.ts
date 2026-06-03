import { api } from './api';
import { track } from './analytics';

export interface WeatherSnapshot {
  observedAt: string;
  tempC: number;
  humidity: number;
  condition: string;
  description: string;
  forecast: Array<{ date: string; minC: number; maxC: number; humidity: number }>;
}

export interface ClimateTip {
  level: 'info' | 'warning';
  appliesTo: Array<'tropical' | 'succulent' | 'outdoor'>;
  message: string;
}

export interface ClimateResponse {
  configured: boolean;
  weather: WeatherSnapshot | null;
  tips: ClimateTip[];
  location?: { city: string; lat: number; lon: number } | null;
}

export interface HouseholdLocation {
  city: string;
  lat: number;
  lon: number;
}

export const climateService = {
  async getClimate(householdId: string): Promise<ClimateResponse> {
    const response = await api.get<ClimateResponse>(`/households/${householdId}/climate`);
    return response.data;
  },

  async setLocation(householdId: string, city: string | null): Promise<unknown> {
    const body = city === null ? null : { city };
    const response = await api.put(`/households/${householdId}/location`, body);
    if (city !== null) track('climate_location_set');
    return response.data;
  },
};
