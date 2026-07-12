/** First-party Sprout client with a deliberately minimized household context. */
import { createHash, createHmac } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import * as plantService from './plantService.js';
import * as taskService from './taskService.js';

export interface SproutCitation {
  title: string;
  url: string;
  source: string;
  fetch_date: string;
}

export interface SproutHouseholdObservation {
  kind: 'collection' | 'tasks';
  value: Record<string, number>;
  provenance: 'household';
}

export interface SproutChatResult {
  text: string;
  citations: SproutCitation[];
  observations: SproutHouseholdObservation[];
  disclosure: string;
}

interface SproutResponse {
  answer: {
    display_text: string;
    citations: SproutCitation[];
    disclosure: string;
    provenance: 'corpus';
  };
  household_observations: SproutHouseholdObservation[];
  context_policy: 'household-data-selects-corpus-facts';
}

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
  plants: Array<{ name: string; species: string | null }>
): string {
  let redacted = question;
  const namedPlants = [...plants]
    .filter((plant) => plant.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  for (const plant of namedPlants) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(plant.name), 'giu'),
      plant.species?.trim() || 'this plant'
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
 * Build the only payload permitted to cross into Sprout. No nickname, free-form
 * location, notes, images, member data, household id, or exact timestamps.
 */
export async function buildSproutContext(householdId: string, now = new Date(), question?: string) {
  const [plants, tasks] = await Promise.all([
    plantService.getPlants(householdId),
    taskService.getTasks(householdId),
  ]);
  const speciesByPlant = new Map(
    plants.filter((plant) => plant.species).map((plant) => [plant.id, plant.species as string])
  );
  return {
    sanitizedQuestion: question === undefined ? undefined : redactSproutQuestion(question, plants),
    plants: plants
      .filter((plant) => plant.species)
      .slice(0, 100)
      .map((plant) => ({ species: plant.species as string, light_profile: 'unknown' as const })),
    tasks: tasks
      .flatMap((task) => {
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
      })
      .slice(0, 100),
  };
}

export async function askSprout(input: {
  householdId: string;
  question: string;
  language?: 'en' | 'es';
}): Promise<SproutChatResult> {
  const baseUrl = process.env.SPROUT_API_URL?.replace(/\/$/, '');
  const secret = await resolveSecret();
  if (!baseUrl || !secret) throw new Error('Sprout integration is enabled but not configured');

  const context = await buildSproutContext(input.householdId, new Date(), input.question);
  const payload = {
    question: context.sanitizedQuestion ?? input.question,
    language: input.language ?? 'en',
    plants: context.plants,
    tasks: context.tasks,
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
    const result = (await response.json()) as SproutResponse;
    if (
      result.answer?.provenance !== 'corpus' ||
      result.context_policy !== 'household-data-selects-corpus-facts'
    ) {
      throw new Error('Sprout returned an invalid provenance contract');
    }
    return {
      text: result.answer.display_text,
      citations: result.answer.citations ?? [],
      observations: result.household_observations ?? [],
      disclosure: result.answer.disclosure,
    };
  } finally {
    clearTimeout(timeout);
  }
}
