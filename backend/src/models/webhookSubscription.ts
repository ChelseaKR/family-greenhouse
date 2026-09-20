/**
 * Outbound webhook subscription model.
 *
 * Households can register webhook URLs to receive real-time notifications
 * when events occur (task completed, task snoozed, plant created, etc.).
 * Each subscription carries an HMAC-SHA256 secret for payload verification.
 */

import { createHmac, randomBytes } from 'node:crypto';

export type WebhookEvent =
  | 'task.completed'
  | 'task.snoozed'
  | 'task.claimed'
  | 'task.unclaimed'
  | 'plant.created'
  | 'plant.updated'
  | 'plant.archived';

export interface WebhookSubscription {
  /** UUID primary key. */
  id: string;
  /** Household this webhook belongs to. */
  householdId: string;
  /** The HTTPS URL to POST events to. */
  url: string;
  /** Host extracted from the URL (for display and SSRF checks). */
  host: string;
  /** Last 4 characters of the URL for masked display. */
  last4: string;
  /** Events this subscription is interested in. */
  events: WebhookEvent[];
  /** HMAC-SHA256 secret (base64url-encoded). The recipient uses this to verify signatures. */
  secret: string;
  /** Current status. */
  status: 'active' | 'disabled';
  /** Why the webhook was disabled (auto-disabled after repeated failures). */
  disabledReason: string | null;
  /** Consecutive delivery failures (resets on success). */
  consecutiveFailures: number;
  /** Consecutive client errors (4xx). Disables after 3. */
  consecutiveClientErrors: number;
  /** ISO instant of the next retry attempt (exponential backoff). */
  nextAttemptAt: string | null;
  /** Details of the most recent failure. */
  lastFailure: WebhookFailure | null;
  /** ISO instant of the last successful delivery. */
  lastDeliveredAt: string | null;
  /** ISO instant of creation. */
  createdAt: string;
  /** ISO instant of last update. */
  updatedAt: string;
}

export interface WebhookFailure {
  at: string;
  kind: DeliveryFailureKind;
  httpStatus: number | null;
}

export type DeliveryFailureKind =
  'client' | 'redirect' | 'rate_limited' | 'server' | 'network' | 'blocked' | 'timeout';

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  householdId: string;
  event: WebhookEvent;
  /** ISO instant of the delivery attempt. */
  attemptedAt: string;
  /** HTTP status code (null for network errors). */
  httpStatus: number | null;
  /** Whether the delivery succeeded. */
  ok: boolean;
  /** Failure kind (null on success). */
  failureKind: DeliveryFailureKind | null;
  /** Response body snippet (first 512 bytes). */
  responseBody: string | null;
}

// --- Constants ---

export const WEBHOOK_MAX_CLIENT_ERRORS = 3;
export const WEBHOOK_MAX_FAILURES = 10;
export const WEBHOOK_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24h
const WEBHOOK_BASE_BACKOFF_MS = 60 * 1000; // 1 minute base (faster than channels)

/** Exponential backoff: 1m, 2m, 4m, 8m, ... capped at 24h. */
export function backoffMs(consecutiveFailures: number, retryAfterSeconds?: number | null): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  const computed = Math.min(WEBHOOK_BASE_BACKOFF_MS * 2 ** exponent, WEBHOOK_MAX_BACKOFF_MS);
  const asked =
    retryAfterSeconds && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1000, WEBHOOK_MAX_BACKOFF_MS)
      : 0;
  return Math.max(computed, asked);
}

// --- HMAC Signing ---

/** Generate a new webhook secret (base64url-encoded, 32 bytes). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 * Returns the signature in the format `v1,<base64url-signature>`.
 */
export function signWebhookPayload(secret: string, payload: string): string {
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `v1,${signature}`;
}

/**
 * Verify a webhook signature against a payload.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string
): boolean {
  const expected = signWebhookPayload(secret, payload);
  if (expected.length !== signature.length) return false;
  return Buffer.from(expected).compare(Buffer.from(signature)) === 0;
}

// --- URL Validation ---

export type ParsedWebhookUrl =
  { ok: true; url: URL; host: string; last4: string } | { ok: false; problem: string };

/** Internal suffixes that should never be webhook targets. */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'localdomain',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
  'test',
  'invalid',
  'example',
];

/**
 * Validate and parse a webhook URL.
 * Accepts any HTTPS URL with a public DNS name (no IP literals, no internal suffixes).
 */
export function parseWebhookUrl(raw: string): ParsedWebhookUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'invalid_url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, problem: 'not_https' };
  }
  if (url.username || url.password) {
    return { ok: false, problem: 'credentials_in_url' };
  }
  if (url.search) {
    return { ok: false, problem: 'query_string_not_allowed' };
  }
  if (url.hash) {
    return { ok: false, problem: 'fragment_not_allowed' };
  }

  const host = url.hostname;
  if (!host || host.includes('..') || host.startsWith('[')) {
    return { ok: false, problem: 'invalid_host' };
  }

  // Block internal suffixes.
  const lowerHost = host.toLowerCase();
  for (const suffix of BLOCKED_SUFFIXES) {
    if (lowerHost === suffix || lowerHost.endsWith('.' + suffix)) {
      return { ok: false, problem: 'internal_host' };
    }
  }

  // Block IP literals.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return { ok: false, problem: 'ip_literal' };
  }

  const last4 = url.pathname.slice(-4) || '****';

  return { ok: true, url, host, last4 };
}

// --- Failure Classification ---

export interface DeliveryOutcome {
  ok: boolean;
  httpStatus?: number;
  kind?: DeliveryFailureKind;
  retryAfterSeconds?: number | null;
}

/** Classify an HTTP status code into a delivery outcome. */
export function classifyStatus(
  status: number,
  retryAfterSeconds: number | null = null
): DeliveryOutcome {
  if (status >= 200 && status < 300) {
    return { ok: true, httpStatus: status };
  }
  if (status >= 300 && status < 400) {
    return { ok: false, kind: 'redirect', httpStatus: status };
  }
  if (status === 429) {
    return {
      ok: false,
      kind: 'rate_limited',
      httpStatus: status,
      retryAfterSeconds,
    };
  }
  if (status >= 400 && status < 500) {
    return { ok: false, kind: 'client', httpStatus: status };
  }
  return { ok: false, kind: 'server', httpStatus: status };
}
