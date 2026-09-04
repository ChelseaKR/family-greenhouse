/**
 * Cached, budget-gated wrapper around the OpenWeatherMap client. Same
 * pattern as services/enrichment.ts for Perenual: rest of the codebase
 * imports this file, never the raw client.
 *
 * Cache TTL is short (1 hour) — weather changes within a day. The budget
 * is generous: we cache per-household, so 24 calls/day per household is
 * a hard ceiling regardless of UI traffic.
 */
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { optionalEnv } from '../utils/env.js';
import * as weather from './weather.js';
import type { WeatherSnapshot, GeocodeResult } from './weather.js';

const WEATHER_TTL_SECONDS = 60 * 60; // 1 hour
const GEOCODE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days; cities don't move
const DEFAULT_DAILY_BUDGET = 800; // free tier is 60/min × 86,400/day; generous

function dailyBudget(): number {
  const raw = optionalEnv('OPENWEATHER_DAILY_BUDGET');
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ttlSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

interface BudgetState {
  used: number;
  limit: number;
  blocked: boolean;
  available: boolean;
}

export type ClimateUnavailableReason =
  'not_configured' | 'budget_exhausted' | 'budget_check_failed' | 'provider';

/** Typed operational failure so HTTP handlers can distinguish "bad city"
 * (a valid empty geocode result) from a retryable integration failure. */
export class ClimateUnavailableError extends Error {
  override readonly name = 'ClimateUnavailableError';

  constructor(readonly reason: ClimateUnavailableReason) {
    super(`Climate integration unavailable: ${reason}`);
  }
}

async function checkAndIncrementBudget(): Promise<BudgetState> {
  const limit = dailyBudget();
  const day = todayKey();
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: 'WEATHER#BUDGET', SK: `DAY#${day}` },
        UpdateExpression: 'ADD #used :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#used': 'used', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':ttl': ttlSeconds(60 * 60 * 24 * 7),
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const used = (result.Attributes?.used as number) ?? 1;
    return { used, limit, blocked: used > limit, available: true };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'weather.budget_check_failed');
    // Fail closed. If the shared counter cannot be read atomically, calling
    // upstream anyway defeats the spend cap and can amplify an outage.
    return { used: 0, limit, blocked: false, available: false };
  }
}

interface CacheRow<T> {
  PK: string;
  SK: string;
  entityType?: string;
  payload: T;
  cachedAt: string;
  ttl?: number;
}

async function readCache<T>(pk: string, sk: string): Promise<T | null> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } })
    );
    const row = result.Item as CacheRow<T> | undefined;
    if (!row) return null;
    if (row.ttl && row.ttl < Math.floor(Date.now() / 1000)) return null;
    return row.payload;
  } catch (err) {
    logger.warn({ err: (err as Error).message, pk, sk }, 'weather.cache_read_failed');
    return null;
  }
}

async function writeCache<T>(pk: string, sk: string, payload: T, ttlSec: number): Promise<void> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: pk,
          SK: sk,
          entityType: 'WeatherCache',
          payload,
          cachedAt: new Date().toISOString(),
          ttl: ttlSeconds(ttlSec),
        } satisfies CacheRow<T>,
      })
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, pk, sk }, 'weather.cache_write_failed');
  }
}

/**
 * Quantize lat/lon to ~10km precision (3 decimals). Two households on the
 * same block share one weather row instead of refetching for a 50m diff.
 */
function quantize(coord: number): string {
  return coord.toFixed(3);
}

export async function geocodeCached(query: string): Promise<GeocodeResult | null> {
  if (!weather.isConfigured()) throw new ClimateUnavailableError('not_configured');
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return null;

  const sk = `GEOCODE#${trimmed}`;
  const cached = await readCache<GeocodeResult>('WEATHER#CACHE', sk);
  if (cached) return cached;

  const budget = await checkAndIncrementBudget();
  if (!budget.available) throw new ClimateUnavailableError('budget_check_failed');
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'weather.budget_exhausted');
    throw new ClimateUnavailableError('budget_exhausted');
  }

  const fresh = await weather.geocodeDetailed(trimmed);
  if (fresh.status === 'unavailable') {
    throw new ClimateUnavailableError(
      fresh.reason === 'not_configured' ? 'not_configured' : 'provider'
    );
  }
  if (fresh.status === 'not_found') return null;
  await writeCache('WEATHER#CACHE', sk, fresh.value, GEOCODE_TTL_SECONDS);
  return fresh.value;
}

export async function getWeatherCached(lat: number, lon: number): Promise<WeatherSnapshot | null> {
  if (!weather.isConfigured()) throw new ClimateUnavailableError('not_configured');

  const sk = `WEATHER#${quantize(lat)},${quantize(lon)}`;
  const cached = await readCache<WeatherSnapshot>('WEATHER#CACHE', sk);
  if (cached) return cached;

  const budget = await checkAndIncrementBudget();
  if (!budget.available) throw new ClimateUnavailableError('budget_check_failed');
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'weather.budget_exhausted');
    throw new ClimateUnavailableError('budget_exhausted');
  }

  const fresh = await weather.getWeatherDetailed(lat, lon);
  if (fresh.status !== 'ok') {
    throw new ClimateUnavailableError(
      fresh.status === 'unavailable' && fresh.reason === 'not_configured'
        ? 'not_configured'
        : 'provider'
    );
  }
  await writeCache('WEATHER#CACHE', sk, fresh.value, WEATHER_TTL_SECONDS);
  return fresh.value;
}

export type CachedWeatherResult =
  { status: 'ok'; snapshot: WeatherSnapshot } | { status: 'miss' } | { status: 'unavailable' };

/**
 * Read the household's cached weather snapshot and NOTHING else — no upstream
 * call, no budget increment, no API key required.
 *
 * `getWeatherCached` above cannot be used from the email path for three
 * reasons: it throws `not_configured` without `OPENWEATHER_API_KEY`, which the
 * digests Lambda deliberately does not have (`local.email_environment`); it
 * calls OpenWeatherMap on a cache miss; and it spends from the shared daily
 * budget. A weekly digest is not worth widening any of that. If a fresh
 * snapshot happens to be in the cache — put there by the household opening the
 * app, which is the common case — the digest uses it, and otherwise it says
 * nothing about the weather.
 *
 * Three outcomes, kept distinct. `miss` means there is no recent snapshot, so
 * the digest makes no weather claim. `unavailable` means the cache READ
 * failed, so the digest says it could not check. Collapsing those two would
 * render a DynamoDB blip as "no weather worth mentioning", which is this
 * repo's named defect class (ADR 0010) — and it is why this does not reuse
 * `readCache`, whose catch returns null for both.
 */
export async function peekCachedWeather(lat: number, lon: number): Promise<CachedWeatherResult> {
  const sk = `WEATHER#${quantize(lat)},${quantize(lon)}`;
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: 'WEATHER#CACHE', SK: sk } })
    );
    const row = result.Item as CacheRow<WeatherSnapshot> | undefined;
    if (!row) return { status: 'miss' };
    if (row.ttl && row.ttl < Math.floor(Date.now() / 1000)) return { status: 'miss' };
    return { status: 'ok', snapshot: row.payload };
  } catch (err) {
    logger.warn({ err: (err as Error).message, sk }, 'weather.peek_read_failed');
    return { status: 'unavailable' };
  }
}

/**
 * Derived care advice from current conditions. The advisor is intentionally
 * blunt — we don't want a five-paragraph essay on the dashboard. Each tip
 * is one short sentence; if no tip applies the array is empty.
 *
 * Mapping happens here (not in the handler) so it's tunable from telemetry
 * without a deploy of a new endpoint shape.
 *
 * Every number in these messages comes from `WeatherSnapshot`, which is
 * OpenWeatherMap's reading for the household's saved city — i.e. it is
 * OUTDOOR weather. We have no indoor sensor and no way to infer one, so no
 * tip may present a snapshot value as a reading from inside the home. The
 * low-humidity tip is still useful (dry outdoor air plus heating means the
 * room is at least as dry) but it must say what it actually measured.
 */
export interface ClimateTip {
  /** Severity. Drives the badge color in the UI. */
  level: 'info' | 'warning';
  /** Plant categories the tip applies to, used for filtering on the
   *  per-plant view. Empty = applies to all plants. */
  appliesTo: Array<'tropical' | 'succulent' | 'outdoor'>;
  message: string;
}

export function deriveClimateTips(snapshot: WeatherSnapshot): ClimateTip[] {
  const tips: ClimateTip[] = [];

  if (snapshot.humidity < 30) {
    tips.push({
      level: 'warning',
      appliesTo: ['tropical'],
      message: `Outdoor humidity is around ${Math.round(snapshot.humidity)}%. Indoor air is usually drier still, so tropical plants benefit from a humidifier or weekly misting.`,
    });
  } else if (snapshot.humidity > 70) {
    tips.push({
      level: 'info',
      appliesTo: ['succulent'],
      message: `High outdoor humidity (${Math.round(snapshot.humidity)}%). Succulents may need extra airflow to avoid rot.`,
    });
  }

  const todayLow = snapshot.forecast[0]?.minC ?? snapshot.tempC;
  if (todayLow < 5) {
    tips.push({
      level: 'warning',
      appliesTo: ['outdoor', 'tropical'],
      message: `Low of ${Math.round(todayLow)}°C tonight. Bring tender plants indoors.`,
    });
  }

  const condition = snapshot.condition.toLowerCase();
  if (condition.includes('rain') || condition.includes('storm')) {
    tips.push({
      level: 'info',
      appliesTo: ['outdoor'],
      message: 'Rain expected — outdoor plants likely don’t need watering today.',
    });
  }

  if (snapshot.tempC > 32) {
    tips.push({
      level: 'warning',
      appliesTo: [],
      message: `Hot today (${Math.round(snapshot.tempC)}°C). Check soil moisture more often than usual.`,
    });
  }

  return tips;
}

export const __testing = {
  checkAndIncrementBudget,
  readCache,
  writeCache,
  quantize,
};
