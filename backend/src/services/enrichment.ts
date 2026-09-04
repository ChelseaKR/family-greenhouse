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

/**
 * `available: false` is the counter's own "we do not know" — the atomic ADD
 * could not be read back. It used to come back as `{ used: 0, blocked: false }`,
 * byte-for-byte what a fresh day under budget looks like, so no caller could
 * tell an unmetered call from a metered one. The fail-open decision is still
 * made — once, in `upstreamCallPermitted` — but it is now made on purpose and
 * logged as the decision it is (compare climate.ts, whose weather counter
 * makes the opposite call and fails closed). ADR 0010.
 */
type BudgetState =
  | { available: true; used: number; limit: number; blocked: boolean }
  | { available: false; limit: number };

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
    return { available: true, used, limit, blocked: used > limit };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'perenual.budget_check_failed');
    return { available: false, limit };
  }
}

/**
 * Whether a metered Perenual call may go ahead. Spends one unit of today's
 * budget as a side effect (the check IS the increment).
 *
 * When the counter cannot be read this fails OPEN: the cache absorbs most
 * traffic, the daily budget is a soft quota rather than a hard spend cap, and
 * a DynamoDB blip should degrade metering before it degrades species lookups
 * (which carry pet toxicity). That choice is logged on every occurrence as
 * `perenual.budget_unverified`, so an outage quietly spending unmetered calls
 * is visible instead of looking like a quiet day.
 */
async function upstreamCallPermitted(): Promise<boolean> {
  const budget = await checkAndIncrementBudget();
  if (!budget.available) {
    logger.warn({ limit: budget.limit, decision: 'fail_open' }, 'perenual.budget_unverified');
    return true;
  }
  if (budget.blocked) {
    logger.warn({ used: budget.used, limit: budget.limit }, 'perenual.budget_exhausted');
    return false;
  }
  return true;
}

interface CacheRow<T> {
  PK: string;
  SK: string;
  entityType?: string;
  payload: T;
  cachedAt: string;
  ttl?: number;
}

type CacheReadResult<T> =
  | { hit: true; value: T }
  /**
   * `unavailable` separates "the row is not there" from "we could not look".
   * Both mean "ask Perenual" to the lookup path, so it ignores the flag — but
   * a CACHE-ONLY caller (peekSpeciesCached) publishes its answer without ever
   * asking Perenual, and for that caller the two are opposite facts. Collapsing
   * them is what let a DynamoDB blip delete a plant from Move Day's frost
   * warning as though it had been checked and cleared (#454).
   */
  | { hit: false; unavailable: boolean };

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
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'payload')) {
      return { hit: false, unavailable: false };
    }
    if (row.ttl && row.ttl < Math.floor(Date.now() / 1000)) {
      return { hit: false, unavailable: false };
    }
    return { hit: true, value: row.payload };
  } catch (err) {
    logger.warn({ err: (err as Error).message, pk, sk }, 'perenual.cache_read_failed');
    return { hit: false, unavailable: true };
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
  // Nullable projection: `null` already means "could not answer" here, so an
  // unset key and an unreadable key store both map to it (perenual.ts logs
  // which). Callers that must tell them apart use lookupSpeciesCached.
  if ((await perenual.configurationStatus()) !== 'configured') return null;
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];

  const sk = `SEARCH#${trimmed}`;
  const cached = await readCache<PerenualSpeciesSummary[]>('PERENUAL#CACHE', sk);
  if (cached) return cached;

  if (!(await upstreamCallPermitted())) return null;

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
  const configuration = await perenual.configurationStatus();
  if (configuration === 'unset') {
    return { status: 'unavailable', reason: 'unconfigured', result: null };
  }
  if (configuration === 'unavailable') {
    // The key store could not be read this time. Retryable — so it must not
    // present as `unconfigured`, which callers treat as permanent.
    return { status: 'unavailable', reason: 'upstream_error', result: null };
  }

  const sk = `SPECIES#${id}`;
  const cached = await readCacheEntry<PerenualSpeciesDetail | null>('PERENUAL#CACHE', sk);
  if (cached.hit) {
    return cached.value === null
      ? { status: 'not_found', result: null }
      : { status: 'found', result: cached.value };
  }

  if (!(await upstreamCallPermitted())) {
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

/**
 * Cache-only species peek. Unlike every other reader here it NEVER falls
 * through to Perenual, so its result is published as-is and must therefore be
 * three-state: a row we have (`cached`, whose value is null for a stored 404),
 * a row we do not have (`absent`), and a read we could not perform
 * (`unavailable`). The last one is the whole point — a caller that renders a
 * safety fact has to be able to say "we could not check this" instead of
 * silently omitting the plant (#454).
 */
export type SpeciesPeekResult =
  | { status: 'cached'; value: PerenualSpeciesDetail | null }
  | { status: 'absent' }
  | { status: 'unavailable' };

/**
 * Read-only view of the species cache. Never calls Perenual and never touches
 * the daily budget — Seasonal Move Day uses this so its hardiness hint costs
 * nothing and is honest about only covering plants whose species were already
 * looked up.
 */
export async function peekSpeciesCached(id: number): Promise<SpeciesPeekResult> {
  const cached = await readCacheEntry<PerenualSpeciesDetail | null>(
    'PERENUAL#CACHE',
    `SPECIES#${id}`
  );
  if (cached.hit) return { status: 'cached', value: cached.value };
  return cached.unavailable ? { status: 'unavailable' } : { status: 'absent' };
}

/** Nullable projection retained for thumbnails, plant validation, and guides. */
export async function getSpeciesCached(id: number): Promise<PerenualSpeciesDetail | null> {
  const lookup = await lookupSpeciesCached(id);
  return lookup.status === 'found' ? lookup.result : null;
}

export async function getCareGuideCached(speciesId: number): Promise<PerenualCareGuide | null> {
  // Nullable projection, same reasoning as searchSpeciesCached.
  if ((await perenual.configurationStatus()) !== 'configured') return null;

  const sk = `GUIDE#${speciesId}`;
  const cached = await readCache<PerenualCareGuide>('PERENUAL#CACHE', sk);
  if (cached) return cached;

  if (!(await upstreamCallPermitted())) return null;

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
  const configuration = await perenual.configurationStatus();
  if (configuration === 'unset') return { ok: false, reason: 'unconfigured' };
  // An unreadable key store is retryable. pestAlerts skips `unconfigured`
  // for the day (it is permanent) but flags any other reason for a retry, so
  // this distinction is what keeps an SSM blip from silently costing a
  // household its pest check.
  if (configuration === 'unavailable') return { ok: false, reason: 'upstream_error' };
  const trimmed = scientificName.trim().toLowerCase();
  const sk = `PESTS#${trimmed}`;
  const cached = await readCache<PerenualPestSummary[]>('PERENUAL#CACHE', sk);
  if (cached) return { ok: true, pests: cached };

  if (!(await upstreamCallPermitted())) return { ok: false, reason: 'budget_exhausted' };

  const fresh = await perenual.listPestsForSpecies(trimmed);
  if (fresh === null) return { ok: false, reason: 'upstream_error' };
  await writeCache('PERENUAL#CACHE', sk, fresh, jitteredTtlSeconds(SPECIES_TTL_DAYS * 86400));
  return { ok: true, pests: fresh };
}

export const __testing = { checkAndIncrementBudget, readCache, readCacheEntry, writeCache };
