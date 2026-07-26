/**
 * The integration boundary between our app and Perenual. Everything that
 * needs species/care data goes through this module, never the raw client.
 *
 * Two pieces wrap the raw client:
 *  - DDB cache. Species details and care guides change rarely; we keep them
 *    for 90 days and treat any cached row as authoritative. Search results
 *    cache for 5 minutes — long enough to coalesce typeahead spam without
 *    feeling stale.
 *  - Daily-budget circuit breaker. Each network call increments a per-day
 *    counter; once we hit the configured ceiling we stop calling Perenual
 *    until the next UTC day. The ceiling is generous; the goal is to stop
 *    runaway usage, not to ration aggressively.
 *
 * Nullable compatibility methods still collapse unavailability into null.
 * User-facing species detail and pest-alert evaluation use discriminated
 * results so "confirmed no result" is never mistaken for "couldn't check."
 */
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { optionalEnv } from '../utils/env.js';
import * as perenual from './perenual.js';
import type {
  PerenualSpeciesSummary,
  PerenualSpeciesDetail,
  PerenualCareGuide,
  PerenualPestSummary,
} from './perenual.js';

const SPECIES_TTL_DAYS = 90;
const SEARCH_TTL_SECONDS = 5 * 60;
const DEFAULT_DAILY_BUDGET = 80; // free tier is 100; leave headroom for retries
// Smears a bulk cache-warm's expiry across up to 6h instead of one instant —
// without jitter, everything written on the same day expires on the same
// day 90 days later, and the resulting burst of cache misses can exceed the
// daily budget and trip the circuit breaker for every caller at once.
const TTL_JITTER_SECONDS = 6 * 60 * 60;

function jitteredTtlSeconds(baseSeconds: number): number {
  return baseSeconds + Math.floor(Math.random() * TTL_JITTER_SECONDS);
}

function dailyBudget(): number {
  const raw = optionalEnv('PERENUAL_DAILY_BUDGET');
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET;
}

function todayKey(): string {
  // UTC date — Perenual quotas reset on UTC midnight per their docs.
  return new Date().toISOString().slice(0, 10);
}

function ttlSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

interface BudgetState {
  used: number;
  limit: number;
  blocked: boolean;
}

async function checkAndIncrementBudget(): Promise<BudgetState> {
  const limit = dailyBudget();
  const day = todayKey();
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: 'PERENUAL#BUDGET', SK: `DAY#${day}` },
        UpdateExpression: 'ADD #used :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#used': 'used', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':ttl': ttlSeconds(60 * 60 * 24 * 7), // sweep after a week
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const used = (result.Attributes?.used as number) ?? 1;
    return { used, limit, blocked: used > limit };
  } catch (err) {
    // If the budget check itself fails we don't want to brick the call —
    // log and proceed. The cache will still absorb most traffic.
    logger.warn({ err: (err as Error).message }, 'perenual.budget_check_failed');
    return { used: 0, limit, blocked: false };
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

type CacheReadResult<T> = { hit: true; value: T } | { hit: false };

/**
 * A hit wrapper is necessary because `null` can itself be a valid cached
 * payload (a confirmed Perenual 404). Returning a bare T|null would make that
 * row indistinguishable from a miss and spend provider budget again.
 */
async function readCacheEntry<T>(pk: string, sk: string): Promise<CacheReadResult<T>> {
  try {
    const result = await dynamodb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } })
    );
    const row = result.Item as CacheRow<T> | undefined;
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'payload')) return { hit: false };
    if (row.ttl && row.ttl < Math.floor(Date.now() / 1000)) return { hit: false };
    return { hit: true, value: row.payload };
  } catch (err) {
    logger.warn({ err: (err as Error).message, pk, sk }, 'perenual.cache_read_failed');
    return { hit: false };
  }
}

async function readCache<T>(pk: string, sk: string): Promise<T | null> {
  const result = await readCacheEntry<T>(pk, sk);
  return result.hit ? result.value : null;
}

async function writeCache<T>(pk: string, sk: string, payload: T, ttlSec: number): Promise<void> {
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: pk,
          SK: sk,
          entityType: 'PerenualCache',
          payload,
          cachedAt: new Date().toISOString(),
          ttl: ttlSeconds(ttlSec),
        } satisfies CacheRow<T>,
      })
    );
  } catch (err) {
    // Cache miss + write failure leaves the next request to retry the API.
    // Acceptable; not worth bricking the response.
    logger.warn({ err: (err as Error).message, pk, sk }, 'perenual.cache_write_failed');
  }
}

export async function searchSpeciesCached(query: string): Promise<PerenualSpeciesSummary[] | null> {
  if (!(await perenual.isConfigured())) return null;
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const sk = `SEARCH#${trimmed}`;
  const cached = await readCache<PerenualSpeciesSummary[]>('PERENUAL#CACHE', sk);
  if (cached) return cached;

  const budget = await checkAndIncrementBudget();
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'perenual.budget_exhausted');
    return null;
  }

  const fresh = await perenual.searchSpecies(trimmed);
  if (fresh) await writeCache('PERENUAL#CACHE', sk, fresh, SEARCH_TTL_SECONDS);
  return fresh;
}

export type SpeciesLookupResult =
  | { status: 'found'; result: PerenualSpeciesDetail }
  | { status: 'not_found'; result: null }
  | {
      status: 'unavailable';
      reason: 'unconfigured' | 'budget_exhausted' | 'upstream_error';
      result: null;
    };

/**
 * Species detail lookup with enough state for a safety-sensitive UI:
 * - a provider 404 is a cacheable `not_found`;
 * - configuration, budget, and upstream failures are retryable unavailable
 *   states and are never written to the result cache.
 */
export async function lookupSpeciesCached(id: number): Promise<SpeciesLookupResult> {
  if (!(await perenual.isConfigured())) {
    return { status: 'unavailable', reason: 'unconfigured', result: null };
  }

  const sk = `SPECIES#${id}`;
  const cached = await readCacheEntry<PerenualSpeciesDetail | null>('PERENUAL#CACHE', sk);
  if (cached.hit) {
    return cached.value === null
      ? { status: 'not_found', result: null }
      : { status: 'found', result: cached.value };
  }

  const budget = await checkAndIncrementBudget();
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'perenual.budget_exhausted');
    return { status: 'unavailable', reason: 'budget_exhausted', result: null };
  }

  const fresh = await perenual.lookupSpecies(id);
  if (fresh.status === 'unavailable') return fresh;

  // Both a detail and a confirmed 404 are stable/cacheable provider answers.
  // Only unavailability skips this write so the next request can retry.
  await writeCache(
    'PERENUAL#CACHE',
    sk,
    fresh.result,
    jitteredTtlSeconds(SPECIES_TTL_DAYS * 86400)
  );
  return fresh;
}

/** Nullable projection retained for thumbnails, plant validation, and guides. */
export async function getSpeciesCached(id: number): Promise<PerenualSpeciesDetail | null> {
  const lookup = await lookupSpeciesCached(id);
  return lookup.status === 'found' ? lookup.result : null;
}

export async function getCareGuideCached(speciesId: number): Promise<PerenualCareGuide | null> {
  if (!(await perenual.isConfigured())) return null;

  const sk = `GUIDE#${speciesId}`;
  const cached = await readCache<PerenualCareGuide>('PERENUAL#CACHE', sk);
  if (cached) return cached;

  const budget = await checkAndIncrementBudget();
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'perenual.budget_exhausted');
    return null;
  }

  const fresh = await perenual.getCareGuide(speciesId);
  if (fresh)
    await writeCache('PERENUAL#CACHE', sk, fresh, jitteredTtlSeconds(SPECIES_TTL_DAYS * 86400));
  return fresh;
}

/**
 * Unlike the other cached lookups (which only need to answer "what's the
 * data, or null"), pest-alert evaluation needs to tell "confirmed no pests"
 * apart from "we don't actually know" — a caller that silently treats budget
 * exhaustion or an upstream error as "no pests" ends up permanently skipping
 * alerts for that plant with no trace of why (see `pestAlerts.ts`). Hence the
 * discriminated result instead of a bare nullable array.
 */
export type PestLookupResult =
  | { ok: true; pests: PerenualPestSummary[] }
  | { ok: false; reason: 'unconfigured' | 'budget_exhausted' | 'upstream_error' };

export async function listPestsForSpeciesCached(scientificName: string): Promise<PestLookupResult> {
  if (!(await perenual.isConfigured())) return { ok: false, reason: 'unconfigured' };
  const trimmed = scientificName.trim().toLowerCase();
  const sk = `PESTS#${trimmed}`;
  const cached = await readCache<PerenualPestSummary[]>('PERENUAL#CACHE', sk);
  if (cached) return { ok: true, pests: cached };

  const budget = await checkAndIncrementBudget();
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'perenual.budget_exhausted');
    return { ok: false, reason: 'budget_exhausted' };
  }

  const fresh = await perenual.listPestsForSpecies(trimmed);
  if (fresh === null) return { ok: false, reason: 'upstream_error' };
  await writeCache('PERENUAL#CACHE', sk, fresh, jitteredTtlSeconds(SPECIES_TTL_DAYS * 86400));
  return { ok: true, pests: fresh };
}

export const __testing = { checkAndIncrementBudget, readCache, readCacheEntry, writeCache };
