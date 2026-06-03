/**
 * OpenWeatherMap client. Same shape as services/perenual.ts: returns null
 * on every failure (network error, non-2xx, missing key, malformed JSON,
 * timeout). Never throws — callers degrade by hiding climate-aware tips
 * rather than surfacing an error.
 *
 * When OPENWEATHER_API_KEY is unset every method short-circuits to null.
 * That's the dev/local default — climate awareness is feature-gated by
 * the presence of the key.
 *
 * Why OpenWeatherMap: free tier of 60 calls/min × 1M calls/month is well
 * past anything we'd hit at our scale (we cache hourly per household).
 * One-call API gives us current + daily aggregate in a single request.
 */
import { optionalEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://api.openweathermap.org';
const TIMEOUT_MS = 5000;

export interface WeatherSnapshot {
  /** ISO timestamp the snapshot was retrieved at. */
  observedAt: string;
  tempC: number;
  /** Relative humidity 0–100. */
  humidity: number;
  /** OpenWeatherMap condition slug, e.g. "Clear", "Rain", "Snow". */
  condition: string;
  /** One-line human description, e.g. "scattered clouds". */
  description: string;
  /** Daily forecast aggregate: today's range + a 3-day outlook. Empty
   *  when the upstream call returned only current conditions. */
  forecast: Array<{ date: string; minC: number; maxC: number; humidity: number }>;
}

export interface GeocodeResult {
  city: string;
  lat: number;
  lon: number;
  country: string | null;
}

function apiKey(): string | undefined {
  return optionalEnv('OPENWEATHER_API_KEY');
}

export function isConfigured(): boolean {
  return apiKey() !== undefined;
}

async function fetchJson<T>(path: string, query: Record<string, string>): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;

  const params = new URLSearchParams({ appid: key, ...query });
  const url = `${BASE_URL}${path}?${params.toString()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      logger.warn({ status: res.status, path }, 'weather.non_2xx');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, 'weather.fetch_failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RawGeocode {
  name: string;
  lat: number;
  lon: number;
  country?: string;
}

interface RawOneCall {
  current?: {
    dt: number;
    temp: number;
    humidity: number;
    weather?: Array<{ main: string; description: string }>;
  };
  daily?: Array<{
    dt: number;
    temp: { min: number; max: number };
    humidity: number;
  }>;
}

/**
 * Forward-geocode a free-text city/region/country string to a single best
 * lat/lon. Returns null if the upstream returns no candidates — caller is
 * responsible for prompting the user to refine.
 */
export async function geocode(query: string): Promise<GeocodeResult | null> {
  const raw = await fetchJson<RawGeocode[]>('/geo/1.0/direct', {
    q: query.trim(),
    limit: '1',
  });
  if (!raw || raw.length === 0) return null;
  const best = raw[0];
  return {
    city: best.name,
    lat: best.lat,
    lon: best.lon,
    country: best.country ?? null,
  };
}

export async function getWeather(lat: number, lon: number): Promise<WeatherSnapshot | null> {
  const raw = await fetchJson<RawOneCall>('/data/3.0/onecall', {
    lat: lat.toString(),
    lon: lon.toString(),
    units: 'metric',
    exclude: 'minutely,hourly,alerts',
  });
  if (!raw?.current) return null;
  const w = raw.current.weather?.[0];
  return {
    observedAt: new Date(raw.current.dt * 1000).toISOString(),
    tempC: raw.current.temp,
    humidity: raw.current.humidity,
    condition: w?.main ?? 'Unknown',
    description: w?.description ?? '',
    forecast: (raw.daily ?? []).slice(0, 3).map((d) => ({
      date: new Date(d.dt * 1000).toISOString().slice(0, 10),
      minC: d.temp.min,
      maxC: d.temp.max,
      humidity: d.humidity,
    })),
  };
}
