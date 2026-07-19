/**
 * Raw Perenual HTTP client. Speaks JSON over fetch; never throws — every
 * method returns null on any failure (network error, non-2xx, missing API
 * key, malformed JSON, timeout) so callers can degrade cleanly.
 *
 * This module is intentionally dumb: no caching, no rate-limit accounting,
 * no retries. Those concerns live in `enrichment.ts`, which wraps this
 * client with a DDB cache and a daily-budget circuit breaker.
 *
 * API key resolution (in priority order):
 *   1. `PERENUAL_API_KEY_PARAMETER_NAME` env → fetched once per warm
 *      container from SSM Parameter Store. Production path. The Lambda role
 *      needs `ssm:GetParameter` on the parameter ARN.
 *   2. `PERENUAL_API_KEY` env → literal value. Dev/local fallback.
 *   3. Neither set → every method short-circuits to null. The integration
 *      is feature-gated by the presence of a key, not by an explicit flag.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import AWSXRay from 'aws-xray-sdk-core';
import { optionalEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://perenual.com/api';
const TIMEOUT_MS = 5000;

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
  // `null` means Perenual has no data for this species — distinct from a
  // confirmed `false`. Collapsing "unknown" into "not toxic" would make the
  // app assert plants are pet-safe when it actually never checked.
  poisonousToPets: boolean | null;
  defaultImageUrl: string | null;
}

export interface PerenualCareGuideSection {
  type: 'watering' | 'sunlight' | 'pruning';
  description: string;
}

export interface PerenualCareGuide {
  speciesId: number;
  sections: PerenualCareGuideSection[];
}

export interface PerenualPestSummary {
  id: number;
  commonName: string;
  scientificName: string | null;
  description: string | null;
  hostScientificNames: string[];
}

// Cache the resolved key for the lifetime of the warm container. Secrets
// Manager rotation is on the order of months/years for an API key like
// this; treating the resolved value as immutable per-container is fine.
// On a rotation, the operator forces a Lambda redeploy and new containers
// pick up the new value.
let resolvedKey: string | undefined;
let resolvedAt: 'env' | 'parameter' | 'unset' | undefined;

const ssmClient = AWSXRay.captureAWSv3Client(
  new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' })
);

async function resolveApiKey(): Promise<string | undefined> {
  if (resolvedAt !== undefined) return resolvedKey;
  const parameterName = optionalEnv('PERENUAL_API_KEY_PARAMETER_NAME');
  if (parameterName) {
    try {
      const out = await ssmClient.send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: true })
      );
      const value = out.Parameter?.Value?.trim();
      if (value) {
        resolvedKey = value;
        resolvedAt = 'parameter';
        return resolvedKey;
      }
      // Genuinely empty parameter: fall through to the literal/unset path
      // below — caching 'unset' is correct for a deliberately blank value.
      logger.warn({ parameterName }, 'perenual.parameter_empty');
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, parameterName },
        'perenual.parameter_fetch_failed'
      );
      // Transient Parameter Store failure (throttle, network, IAM blip):
      // do NOT cache the 'unset' sentinel — leave resolvedAt undefined so
      // the next call retries instead of disabling the integration for the
      // container lifetime. Still honor a literal env fallback if present.
      const fallback = optionalEnv('PERENUAL_API_KEY');
      if (fallback) {
        resolvedKey = fallback;
        resolvedAt = 'env';
        return resolvedKey;
      }
      return undefined;
    }
  }
  const literal = optionalEnv('PERENUAL_API_KEY');
  if (literal) {
    resolvedKey = literal;
    resolvedAt = 'env';
    return resolvedKey;
  }
  resolvedAt = 'unset';
  return undefined;
}

export async function isConfigured(): Promise<boolean> {
  return (await resolveApiKey()) !== undefined;
}

/** Test hook — lets unit tests force a re-resolution between cases. */
export function __resetApiKeyForTests(): void {
  resolvedKey = undefined;
  resolvedAt = undefined;
}

async function fetchJson<T>(path: string, query: Record<string, string> = {}): Promise<T | null> {
  const key = await resolveApiKey();
  if (!key) return null;

  const params = new URLSearchParams({ key, ...query });
  const url = `${BASE_URL}${path}?${params.toString()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      logger.warn({ status: res.status, path }, 'perenual.non_2xx');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, 'perenual.fetch_failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface RawSpeciesListItem {
  id: number;
  common_name: string;
  scientific_name: string[] | string;
  default_image?: { thumbnail?: string } | null;
}

interface RawSpeciesDetail extends RawSpeciesListItem {
  family: string | null;
  cycle: string | null;
  watering: string | null;
  sunlight: string[] | null;
  hardiness?: { min: string; max: string } | null;
  indoor: boolean | null;
  edible_fruit: boolean | null;
  poisonous_to_pets: boolean | number | null;
  default_image?: { original_url?: string; thumbnail?: string } | null;
}

interface RawCareGuide {
  data?: Array<{
    id: number;
    species_id: number;
    section: Array<{ type: string; description: string }>;
  }>;
}

interface RawPestList {
  data?: Array<{
    id: number;
    common_name: string;
    scientific_name?: string | null;
    description?: string | null;
    host?: string[];
  }>;
}

function summarize(item: RawSpeciesListItem): PerenualSpeciesSummary {
  const scientific = Array.isArray(item.scientific_name)
    ? item.scientific_name[0]
    : item.scientific_name;
  return {
    id: item.id,
    // Thin-data species can have a null common_name despite the raw type
    // asserting `string` (untrusted upstream JSON — see fetchJson). Fall back
    // to the scientific name so callers never see/crash on a null.
    commonName: item.common_name ?? scientific ?? '',
    scientificName: scientific ?? '',
    thumbnailUrl: item.default_image?.thumbnail ?? null,
  };
}

function watering(raw: string | null): PerenualSpeciesDetail['watering'] {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'frequent' || v === 'average' || v === 'minimum' || v === 'none') return v;
  return null;
}

// Distinguishes "confirmed toxic" / "confirmed not toxic" from "Perenual has
// no data" (null/undefined/any shape we don't recognize) — see the doc
// comment on `PerenualSpeciesDetail.poisonousToPets`.
function poisonousToPets(raw: boolean | number | null | undefined): boolean | null {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  return null;
}

export async function searchSpecies(query: string): Promise<PerenualSpeciesSummary[] | null> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const raw = await fetchJson<{ data?: RawSpeciesListItem[] }>('/species-list', { q: trimmed });
  if (!raw?.data) return null;
  return raw.data.slice(0, 12).map(summarize);
}

export async function getSpecies(id: number): Promise<PerenualSpeciesDetail | null> {
  const raw = await fetchJson<RawSpeciesDetail>(`/species/details/${id}`);
  if (!raw) return null;
  const summary = summarize(raw);
  return {
    ...summary,
    family: raw.family ?? null,
    cycle: raw.cycle ?? null,
    watering: watering(raw.watering),
    sunlight: Array.isArray(raw.sunlight) ? raw.sunlight : [],
    hardinessZone:
      raw.hardiness && raw.hardiness.min && raw.hardiness.max
        ? `${raw.hardiness.min}-${raw.hardiness.max}`
        : null,
    indoor: raw.indoor === true,
    edible: raw.edible_fruit === true,
    poisonousToPets: poisonousToPets(raw.poisonous_to_pets),
    defaultImageUrl: raw.default_image?.original_url ?? null,
  };
}

export async function getCareGuide(speciesId: number): Promise<PerenualCareGuide | null> {
  const raw = await fetchJson<RawCareGuide>('/species-care-guide-list', {
    species_id: String(speciesId),
  });
  // `null` here means the request itself failed (network/non-2xx/timeout) —
  // not cacheable, the caller should retry. Distinct from the request
  // succeeding with genuinely no guide for this species (below), which IS a
  // real, cacheable answer — same distinction `searchSpecies` already makes
  // for an empty result set. Conflating the two meant a species with no
  // guide was never cached and re-spent budget on every single request.
  if (!raw) return null;
  const guide = raw.data?.[0];
  if (!guide) return { speciesId, sections: [] };
  // `section` is typed as a required array, but that's a compile-time
  // assertion, not a runtime guarantee (see fetchJson) — a thin-data guide
  // entry can genuinely omit it. The module promises "never throws"; honor
  // that here instead of letting a malformed response 500 the endpoint.
  if (!Array.isArray(guide.section)) return { speciesId: guide.species_id, sections: [] };
  const sections: PerenualCareGuideSection[] = guide.section
    .filter((s) => s.type === 'watering' || s.type === 'sunlight' || s.type === 'pruning')
    .map((s) => ({ type: s.type as PerenualCareGuideSection['type'], description: s.description }));
  return { speciesId: guide.species_id, sections };
}

export async function listPestsForSpecies(
  scientificName: string
): Promise<PerenualPestSummary[] | null> {
  const raw = await fetchJson<RawPestList>('/pest-disease-list', {});
  if (!raw?.data) return null;
  const target = scientificName.toLowerCase();
  return raw.data
    .filter((p) => (p.host ?? []).some((h) => h.toLowerCase().includes(target)))
    .map((p) => ({
      id: p.id,
      commonName: p.common_name,
      scientificName: p.scientific_name ?? null,
      description: p.description ?? null,
      hostScientificNames: p.host ?? [],
    }));
}
