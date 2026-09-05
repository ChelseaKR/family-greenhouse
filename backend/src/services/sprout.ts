/** First-party Sprout client with a deliberately minimized household context. */
import { createHash, createHmac } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import * as plantService from './plantService.js';
import * as taskService from './taskService.js';

export interface SproutCitation {
  title: string;
  url: string;
  source: string;
  fetch_date: string;
}

/**
 * How much of the household one set in the outbound payload actually
 * represents (#549).
 *
 * `buildSproutContext` reduces the household TWICE before anything crosses:
 * a privacy FILTER (only the server-resolved canonical species may cross, so
 * a plant that has never been species-matched is dropped outright) and then a
 * CAP. Both used to be invisible — the payload carried `plants` and `tasks`
 * and nothing else — so Sprout answered "how many of my plants are toxic to
 * cats?" from a subset it had no way to know was a subset, and the answer came
 * back stamped `provenance: 'household'`.
 *
 * These are aggregate integers only. No strings, so the boundary contract
 * documented on `buildSproutContext` is unchanged: this says HOW MANY plants
 * did not cross, never anything about them.
 */
export interface SproutSetCoverage {
  /** Everything of this kind the household has. */
  total: number;
  /** How many of them actually crossed into the payload. */
  included: number;
  /** Dropped by the canonical-species privacy filter — never matched. */
  unmatched: number;
  /** Dropped by the cap, AFTER the filter. */
  truncated: number;
  /** The cap that was applied, so a consumer can see why `truncated` is >0. */
  cap: number;
  /**
   * `included === total`. The ONLY state in which a bare count over this set
   * is a true statement about the household.
   */
  complete: boolean;
}

/** Coverage for both sets, plus the one-line answer a consumer usually wants. */
export interface SproutCoverage {
  plants: SproutSetCoverage;
  tasks: SproutSetCoverage;
  /** True when EITHER set is a strict subset of the household. */
  partial: boolean;
}

export interface SproutHouseholdObservation {
  kind: 'collection' | 'tasks';
  value: Record<string, number>;
  provenance: 'household';
  /**
   * What set the numbers in `value` were actually computed over.
   *
   * Attached HERE, on our side, from our own count of the household — it is
   * never read from Sprout's reply, so Sprout cannot overstate its own
   * coverage. `provenance: 'household'` says where a number came from; this
   * says how much of the household it covers. A consumer that renders the
   * number without reading `coverage.complete` is rendering a subset as a
   * total, which is the whole of #549.
   */
  coverage: SproutSetCoverage;
}

export interface SproutChatResult {
  text: string;
  citations: SproutCitation[];
  observations: SproutHouseholdObservation[];
  disclosure: string;
  /** Coverage of the payload this answer was produced from. Present whether or
   *  not Sprout returned any observation, because the PROSE is derived from the
   *  same reduced set. */
  coverage: SproutCoverage;
}

const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'Citation URLs must use HTTPS',
  });

const sproutResponseSchema = z.object({
  answer: z.object({
    display_text: z.string().min(1).max(20_000),
    citations: z
      .array(
        z.object({
          title: z.string().min(1).max(300),
          url: httpsUrl,
          source: z.string().min(1).max(300),
          fetch_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
      )
      .max(20),
    disclosure: z.string().max(2_000),
    provenance: z.literal('corpus'),
  }),
  household_observations: z
    .array(
      z.object({
        kind: z.enum(['collection', 'tasks']),
        value: z.record(z.string(), z.number().finite()),
        provenance: z.literal('household'),
      })
    )
    .max(20),
  context_policy: z.literal('household-data-selects-corpus-facts'),
});

export function isSproutIntegrationEnabled(): boolean {
  return process.env.SPROUT_INTEGRATION_ENABLED === '1';
}

let cachedSecret: string | undefined;
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function resolveSecret(): Promise<string | undefined> {
  if (cachedSecret) return cachedSecret;
  const secretId = process.env.SPROUT_INTEGRATION_SECRET_ID?.trim();
  if (secretId) {
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    cachedSecret = result.SecretString?.trim();
    if (cachedSecret) return cachedSecret;
  }
  cachedSecret = process.env.SPROUT_INTEGRATION_SECRET?.trim();
  return cachedSecret;
}

export function __resetSproutSecretForTests(): void {
  cachedSecret = undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signSproutBody(secret: string, timestamp: string, body: string): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update(`${timestamp}\n${digest}`).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove known local identifiers before a user's free-text question crosses services. */
export function redactSproutQuestion(
  question: string,
  plants: Array<{ name: string; canonicalSpecies?: string | null }>
): string {
  let redacted = question;
  const namedPlants = [...plants]
    .filter((plant) => plant.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  for (const plant of namedPlants) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(plant.name), 'giu'),
      plant.canonicalSpecies?.trim() || 'this plant'
    );
  }
  return redacted
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email redacted]')
    .replace(/(?:\+?\d[\d().\s-]{7,}\d)/gu, '[phone redacted]');
}

function daysBetween(date: string, now: Date): number {
  return Math.round((new Date(date).getTime() - now.getTime()) / 86_400_000);
}

/**
 * Ceiling on how many plants and how many tasks may cross in one request.
 *
 * It is a real cap, not a page size — there is no continuation and nothing
 * fetches the remainder. It stays for now because the payload crosses a
 * service boundary and an unbounded household would make the request size
 * unbounded with it; whether to raise or remove it is a separate call for the
 * owner (#549 suggests it may never have been load-bearing, citing
 * `getYearInReview`). What changes here is that it can no longer apply
 * silently: `SproutSetCoverage.truncated` reports exactly how many rows it
 * removed.
 */
export const SPROUT_CONTEXT_CAP = 100;

function coverage(total: number, matched: number, included: number): SproutSetCoverage {
  return {
    total,
    included,
    unmatched: total - matched,
    truncated: matched - included,
    cap: SPROUT_CONTEXT_CAP,
    complete: included === total,
  };
}

/**
 * Build the only payload permitted to cross into Sprout. `species` is the
 * server-resolved canonical value, never the adjacent client-editable field.
 * No nickname, free-form species/location, notes, images, member data,
 * household id, or exact timestamps cross this boundary.
 *
 * The set that crosses is a SUBSET of the household, twice over, and the
 * returned `coverage` is what says so (#549). Before it existed, a household
 * whose plants had never been species-matched sent `plants: []` — indis-
 * tinguishable, to the thing answering, from a household with no plants.
 * `coverage` adds aggregate integers only, so the boundary above is unchanged.
 */
export async function buildSproutContext(householdId: string, now = new Date(), question?: string) {
  const [plants, tasks] = await Promise.all([
    plantService.getPlants(householdId),
    taskService.getTasks(householdId),
  ]);
  // The privacy filter. Everything downstream of this point is a subset, so
  // the matched counts are kept rather than being recomputed from the capped
  // arrays — the cap and the filter drop rows for different reasons and the
  // payload has to be able to tell them apart.
  const matchedPlants = plants.filter((plant) => plant.canonicalSpecies);
  const speciesByPlant = new Map(
    matchedPlants.map((plant) => [plant.id, plant.canonicalSpecies as string])
  );
  const includedPlants = matchedPlants.slice(0, SPROUT_CONTEXT_CAP).map((plant) => ({
    species: plant.canonicalSpecies as string,
    light_profile: 'unknown' as const,
  }));
  const matchedTasks = tasks.flatMap((task) => {
    const species = speciesByPlant.get(task.plantId);
    if (!species) return [];
    return [
      {
        plant_species: species,
        task_type: task.type,
        due_in_days: Math.max(-365, Math.min(365, daysBetween(task.nextDue, now))),
        last_completed_days_ago: task.lastCompleted
          ? Math.max(0, Math.min(3650, -daysBetween(task.lastCompleted, now)))
          : null,
      },
    ];
  });
  const includedTasks = matchedTasks.slice(0, SPROUT_CONTEXT_CAP);

  const plantCoverage = coverage(plants.length, matchedPlants.length, includedPlants.length);
  const taskCoverage = coverage(tasks.length, matchedTasks.length, includedTasks.length);

  return {
    sanitizedQuestion: question === undefined ? undefined : redactSproutQuestion(question, plants),
    plants: includedPlants,
    tasks: includedTasks,
    coverage: {
      plants: plantCoverage,
      tasks: taskCoverage,
      partial: !plantCoverage.complete || !taskCoverage.complete,
    } satisfies SproutCoverage,
  };
}

export async function askSprout(input: {
  householdId: string;
  question: string;
  language?: 'en' | 'es';
}): Promise<SproutChatResult> {
  const baseUrl = validatedSproutBaseUrl(process.env.SPROUT_API_URL);
  const secret = await resolveSecret();
  if (!baseUrl || !secret) throw new Error('Sprout integration is enabled but not configured');

  const context = await buildSproutContext(input.householdId, new Date(), input.question);
  const payload = {
    question: context.sanitizedQuestion ?? input.question,
    language: input.language ?? 'en',
    plants: context.plants,
    tasks: context.tasks,
    // Aggregate integers describing how much of the household `plants` and
    // `tasks` above actually represent (#549). Sent so the answer can be
    // qualified at the point it is written rather than corrected afterwards.
    // Sprout rejects unknown payload fields (docs/sprout-integration.md), so
    // this field has to land on that side before the integration flag is
    // turned on; it is off in every environment today.
    coverage: context.coverage,
  };
  const body = canonicalJson(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${baseUrl}/api/integrations/family-greenhouse/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sprout-Timestamp': timestamp,
        'X-Sprout-Signature': signSproutBody(secret, timestamp, body),
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Sprout returned HTTP ${response.status}`);
    const parsed = sproutResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      // Treat Sprout as untrusted at the service boundary. In particular,
      // citations become clickable links in the chat UI, so a TypeScript cast
      // alone cannot be allowed to pass a javascript: URL or malformed shape.
      throw new Error('Sprout returned an invalid provenance or response contract');
    }
    const result = parsed.data;
    return {
      text: result.answer.display_text,
      citations: result.answer.citations ?? [],
      // Each household observation is a NUMBER ABOUT THE USER'S OWN COLLECTION,
      // stamped `provenance: 'household'` by Sprout. Carry the coverage of the
      // set it was actually computed over alongside it, taken from our own
      // count rather than from the reply, so no consumer can render a subset as
      // a household total without having been told (#549). 'collection'
      // observations are over the plants set; 'tasks' over the tasks set.
      observations: (result.household_observations ?? []).map((observation) => ({
        ...observation,
        coverage: observation.kind === 'tasks' ? context.coverage.tasks : context.coverage.plants,
      })),
      disclosure: result.answer.disclosure,
      coverage: context.coverage,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const PRODUCTION_SPROUT_HOST = 'api.sprout.chelseakr.com';

export function validatedSproutBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SPROUT_API_URL must be a valid HTTPS URL');
  }
  const testHostAllowed =
    process.env.NODE_ENV === 'test' &&
    (url.hostname === 'sprout.example' || url.hostname.endsWith('.sprout.example'));
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    (url.hostname !== PRODUCTION_SPROUT_HOST && !testHostAllowed)
  ) {
    throw new Error(`SPROUT_API_URL must use HTTPS on the approved ${PRODUCTION_SPROUT_HOST} host`);
  }
  return url.toString().replace(/\/$/, '');
}
