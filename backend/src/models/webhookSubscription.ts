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
  id: string;
  householdId: string;
  url: string;
  host: string;
  last4: string;
  events: WebhookEvent[];
  secret: string;
  status: 'active' | 'disabled';
  disabledReason: string | null;
  consecutiveFailures: number;
  consecutiveClientErrors: number;
  nextAttemptAt: string | null;
  lastFailure: WebhookFailure | null;
  lastDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookFailure {
  at: string;
  kind: DeliveryFailureKind;
  httpStatus: number | null;
}

export type DeliveryFailureKind =
  'client' | 'redirect' | 'rate_limited' | 'server' | 'network' | 'blocked' | 'timeout';

export const WEBHOOK_MAX_CLIENT_ERRORS = 3;
export const WEBHOOK_MAX_FAILURES = 10;
export const WEBHOOK_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_BASE_BACKOFF_MS = 60 * 1000;

export function backoffMs(consecutiveFailures: number, retryAfterSeconds?: number | null): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  const computed = Math.min(WEBHOOK_BASE_BACKOFF_MS * 2 ** exponent, WEBHOOK_MAX_BACKOFF_MS);
  const asked =
    retryAfterSeconds && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1000, WEBHOOK_MAX_BACKOFF_MS)
      : 0;
  return Math.max(computed, asked);
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function signWebhookPayload(secret: string, payload: string): string {
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `v1,${signature}`;
}

export function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string
): boolean {
  const expected = signWebhookPayload(secret, payload);
  if (expected.length !== signature.length) return false;
  return Buffer.from(expected).compare(Buffer.from(signature)) === 0;
}

export type ParsedWebhookUrl =
  { ok: true; url: URL; host: string; last4: string } | { ok: false; problem: string };

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

export function parseWebhookUrl(raw: string): ParsedWebhookUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { ok: false, problem: 'not_https' };
  if (url.username || url.password) return { ok: false, problem: 'credentials_in_url' };
  if (url.search) return { ok: false, problem: 'query_string_not_allowed' };
  if (url.hash) return { ok: false, problem: 'fragment_not_allowed' };

  const host = url.hostname;
  if (!host || host.includes('..') || host.startsWith('[')) {
    return { ok: false, problem: 'invalid_host' };
  }

  const lowerHost = host.toLowerCase();
  for (const suffix of BLOCKED_SUFFIXES) {
    if (lowerHost === suffix || lowerHost.endsWith('.' + suffix)) {
      return { ok: false, problem: 'internal_host' };
    }
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return { ok: false, problem: 'ip_literal' };
  }

  const last4 = url.pathname.slice(-4) || '****';
  return { ok: true, url, host, last4 };
}

export interface DeliveryOutcome {
  ok: boolean;
  httpStatus?: number;
  kind?: DeliveryFailureKind;
  retryAfterSeconds?: number | null;
}

export function classifyStatus(
  status: number,
  retryAfterSeconds: number | null = null
): DeliveryOutcome {
  if (status >= 200 && status < 300) return { ok: true, httpStatus: status };
  if (status >= 300 && status < 400) return { ok: false, kind: 'redirect', httpStatus: status };
  if (status === 429)
    return { ok: false, kind: 'rate_limited', httpStatus: status, retryAfterSeconds };
  if (status >= 400 && status < 500) return { ok: false, kind: 'client', httpStatus: status };
  return { ok: false, kind: 'server', httpStatus: status };
}
