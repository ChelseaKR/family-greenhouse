/**
 * Household chat channel (#674) — the PURE half: the shapes, the request
 * schema, and the rule for which webhook addresses we will ever post to.
 *
 * No I/O and no AWS imports, so `local-server.ts` can validate and mask an
 * address with the exact code production uses (the reason
 * `models/sitterBriefFields.ts` exists applies here too: `utils/dynamodb.ts`
 * throws at import time outside a Lambda).
 *
 * ## The address is a password
 *
 * A Discord, Slack or Matrix incoming-webhook URL is a bearer credential:
 * whoever holds it can post into the family chat as us. So it is sealed with
 * KMS before it is stored (`services/channelSecret.ts`), it never appears in a
 * response or a log line, and the only thing a settings page ever sees is
 * `maskWebhookUrl` — the host and the last four characters.
 *
 * ## Which addresses are accepted
 *
 * `parseWebhookUrl` is an ALLOW-list, per platform, and it is structural only:
 *
 *   - `https:` and nothing else, on the default port, with no user-info, no
 *     query string and no fragment.
 *   - Discord: exactly `discord.com`, path `/api/webhooks/{id}/{token}`.
 *   - Slack: exactly `hooks.slack.com`, path `/services/{team}/{bot}/{secret}`.
 *   - Matrix: the admin's own homeserver, so the host cannot be pinned. It must
 *     be a public-looking DNS name — never an IP literal, never a single label,
 *     never a reserved or internal suffix — and the path must end in
 *     `/webhook/{id}` (the matrix-hookshot generic-webhook shape).
 *
 * Structure is not enough on its own for Matrix, where the admin chooses the
 * host: a name can resolve to 10.0.0.1 or 169.254.169.254. That half is
 * enforced at CONNECT time by `services/channelSsrfGuard.ts`, on every
 * delivery, against the address the socket actually uses — which is what
 * closes DNS rebinding. Redirects are never followed
 * (`services/channelWebhookTransport.ts`).
 */
import { z } from 'zod';

export const CHANNEL_PLATFORMS = ['discord', 'slack', 'matrix'] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export const CHANNEL_LOCALES = ['en', 'es'] as const;
export type ChannelLocale = (typeof CHANNEL_LOCALES)[number];

/** What a channel can be told. Both are household-level lists of plant care;
 *  neither ever names a person. */
export interface ChannelEvents {
  /** The morning list of care due today or overdue. */
  dailyDue: boolean;
  /** Once a week: upcoming tasks nobody has claimed. */
  upForGrabs: boolean;
}

export type ChannelStatus = 'active' | 'disabled';

/** Why delivery stopped. Each is something the admin can act on. */
export type ChannelDisabledReason =
  /** The platform refused the post several times in a row (4xx): the webhook
   *  was deleted, its token rotated, or the channel archived. */
  | 'repeated_client_errors'
  /** The webhook answered with a redirect, which we never follow. */
  | 'redirect'
  /** The address resolved to a private, loopback or link-local network. */
  | 'blocked_address'
  /** Failing for days on end for any reason (5xx, timeouts). */
  | 'repeated_failures';

/** One delivery attempt that did not land, as recorded for the admin. */
export type DeliveryFailureKind =
  'client' | 'redirect' | 'rate_limited' | 'server' | 'network' | 'blocked' | 'unsealable';

export interface ChannelFailure {
  at: string;
  kind: DeliveryFailureKind;
  /** The HTTP status when there was one. Never the response body. */
  httpStatus: number | null;
}

/**
 * The stored row, minus the DynamoDB keys. `sealedUrl` is KMS ciphertext
 * bound to the household by encryption context; nothing in this module can
 * read it and nothing outside `services/householdChannel*.ts` ever should.
 */
export interface HouseholdChannelRecord {
  householdId: string;
  platform: ChannelPlatform;
  sealedUrl: string;
  /** Random per connect. A failure or success recorded against an older
   *  version (the admin replaced the address mid-run) is discarded. */
  urlVersion: string;
  host: string;
  last4: string;
  events: ChannelEvents;
  /** Quiet hours, `HH:MM` in `timezone`, or `''` for none. */
  quietStart: string;
  quietEnd: string;
  timezone: string;
  locale: ChannelLocale;
  status: ChannelStatus;
  disabledReason: ChannelDisabledReason | null;
  consecutiveFailures: number;
  consecutiveClientErrors: number;
  /** Backoff: no scheduled post before this instant. */
  nextAttemptAt: string | null;
  lastFailure: ChannelFailure | null;
  lastDeliveredAt: string | null;
  lastTestAt: string | null;
  connectedBy: string;
  connectedAt: string;
  updatedAt: string;
}

/** Everything a settings page may see. No URL, no ciphertext, no user id. */
export interface HouseholdChannelSummary {
  platform: ChannelPlatform;
  maskedUrl: string;
  events: ChannelEvents;
  quietStart: string;
  quietEnd: string;
  timezone: string;
  locale: ChannelLocale;
  status: ChannelStatus;
  disabledReason: ChannelDisabledReason | null;
  lastFailure: ChannelFailure | null;
  lastDeliveredAt: string | null;
  nextAttemptAt: string | null;
  connectedAt: string;
}

export function toChannelSummary(record: HouseholdChannelRecord): HouseholdChannelSummary {
  return {
    platform: record.platform,
    maskedUrl: formatMaskedUrl(record.host, record.last4),
    events: { dailyDue: record.events.dailyDue, upForGrabs: record.events.upForGrabs },
    quietStart: record.quietStart,
    quietEnd: record.quietEnd,
    timezone: record.timezone,
    locale: record.locale,
    status: record.status,
    disabledReason: record.disabledReason,
    lastFailure: record.lastFailure,
    lastDeliveredAt: record.lastDeliveredAt,
    nextAttemptAt: record.nextAttemptAt,
    connectedAt: record.connectedAt,
  };
}

// ---------------------------------------------------------------------------
// Failure policy. Constants, so the tests and the docs quote one source.
// ---------------------------------------------------------------------------

/** Consecutive 4xx answers before delivery stops and the admin is told. */
export const CHANNEL_MAX_CLIENT_ERRORS = 3;
/** Consecutive failures of any kind before delivery stops. With the backoff
 *  below this is roughly five days of an endpoint that never answers. */
export const CHANNEL_MAX_FAILURES = 10;
/** Backoff after the Nth consecutive failure: 1h, 2h, 4h … capped here. */
export const CHANNEL_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const CHANNEL_BASE_BACKOFF_MS = 60 * 60 * 1000;

export function backoffMs(consecutiveFailures: number, retryAfterSeconds?: number | null): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  const computed = Math.min(CHANNEL_BASE_BACKOFF_MS * 2 ** exponent, CHANNEL_MAX_BACKOFF_MS);
  const asked =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
      ? Math.min(retryAfterSeconds * 1000, CHANNEL_MAX_BACKOFF_MS)
      : 0;
  return Math.max(computed, asked);
}

// ---------------------------------------------------------------------------
// Webhook address validation
// ---------------------------------------------------------------------------

/** Longest address we will store. Real ones are ~120 characters. */
export const WEBHOOK_URL_MAX_LENGTH = 512;

export type WebhookUrlProblem =
  | 'not_a_url'
  | 'too_long'
  | 'not_https'
  | 'has_credentials'
  | 'has_port'
  | 'has_query'
  | 'wrong_host'
  | 'ip_literal'
  | 'private_host'
  | 'wrong_path';

export type ParsedWebhookUrl =
  { ok: true; url: URL; host: string; last4: string } | { ok: false; problem: WebhookUrlProblem };

const DISCORD_PATH = /^\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,128}$/;
const SLACK_PATH = /^\/services\/[A-Z0-9]{5,20}\/[A-Z0-9]{5,20}\/[A-Za-z0-9]{16,64}$/;
/** Optional prefix segments, then `/webhook/{id}` (hookshot's generic hook). */
const MATRIX_PATH = /^(?:\/[A-Za-z0-9._~-]+)*\/webhooks?\/[A-Za-z0-9._~-]{8,256}$/;

/** A DNS label, after the URL parser has lower-cased and punycoded it. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Names that resolve inside a network rather than on the internet. The SSRF
 * guard would refuse what these resolve to anyway; refusing the NAME as well
 * gives the admin an answer at save time instead of a disconnected channel
 * the next morning.
 */
const INTERNAL_SUFFIXES = [
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

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  // The WHATWG parser already turned `2130706433` and `0x7f.1` into dotted
  // quads for special schemes, so a dotted quad is the only v4 form left.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isInternalName(hostname: string): boolean {
  if (!hostname.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isPublicDnsName(hostname: string): boolean {
  if (hostname.endsWith('.')) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  // A top-level label is never all digits.
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/**
 * Parse and allow-list one webhook address for one platform.
 *
 * Returns a named problem rather than throwing so the route can answer with a
 * precise 400 and the delivery path can refuse without a try/catch.
 */
export function parseWebhookUrl(platform: ChannelPlatform, raw: string): ParsedWebhookUrl {
  const input = raw.trim();
  if (input.length > WEBHOOK_URL_MAX_LENGTH) return { ok: false, problem: 'too_long' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, problem: 'not_a_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, problem: 'not_https' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, problem: 'has_credentials' };
  }
  // `URL` drops an explicit :443 for https, so any port left is non-default.
  if (url.port !== '') return { ok: false, problem: 'has_port' };
  if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
    return { ok: false, problem: 'has_query' };
  }
  const hostname = url.hostname;
  if (isIpLiteral(hostname)) return { ok: false, problem: 'ip_literal' };

  switch (platform) {
    case 'discord':
      if (hostname !== 'discord.com') return { ok: false, problem: 'wrong_host' };
      if (!DISCORD_PATH.test(url.pathname)) return { ok: false, problem: 'wrong_path' };
      break;
    case 'slack':
      if (hostname !== 'hooks.slack.com') return { ok: false, problem: 'wrong_host' };
      if (!SLACK_PATH.test(url.pathname)) return { ok: false, problem: 'wrong_path' };
      break;
    case 'matrix':
      if (!isPublicDnsName(hostname)) return { ok: false, problem: 'wrong_host' };
      if (isInternalName(hostname)) return { ok: false, problem: 'private_host' };
      if (!MATRIX_PATH.test(url.pathname)) return { ok: false, problem: 'wrong_path' };
      break;
  }

  return { ok: true, url, host: hostname, last4: input.slice(-4) };
}

/**
 * What a settings page shows in place of the address: `discord.com/…a1B2`.
 * A label, not a link — joined rather than templated so the app-links gate,
 * which reads `${origin}/path` as a page link, does not mistake it for one.
 */
export function formatMaskedUrl(host: string, last4: string): string {
  return [host, `…${last4}`].join('/');
}

/** Plain-English reasons, for the 400 body. Short, and never echo the URL. */
export const WEBHOOK_URL_PROBLEM_MESSAGES: Record<WebhookUrlProblem, string> = {
  not_a_url: 'That is not a web address.',
  too_long: 'That address is too long to be a webhook.',
  not_https: 'The webhook address must start with https://.',
  has_credentials: 'The webhook address must not contain a user name or password.',
  has_port: 'The webhook address must not name a port.',
  has_query: 'Paste the webhook address without anything after a ? or #.',
  wrong_host: 'That address is not a webhook for the chosen chat service.',
  ip_literal: 'Use the server’s name, not an IP address.',
  private_host: 'That server name points inside a private network.',
  wrong_path: 'That address does not look like an incoming webhook for the chosen chat service.',
};

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const quietTime = z.union([z.literal(''), z.string().regex(HHMM, 'Use HH:MM')]);

export const saveHouseholdChannelSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS),
    /** Required when connecting or changing platform; omit to keep the stored
     *  address and change only the settings. */
    url: z.string().min(1).max(WEBHOOK_URL_MAX_LENGTH).optional(),
    events: z.object({ dailyDue: z.boolean(), upForGrabs: z.boolean() }).strict(),
    quietStart: quietTime,
    quietEnd: quietTime,
    timezone: z.string().min(1).max(64),
    locale: z.enum(CHANNEL_LOCALES),
  })
  .strict()
  .refine((body) => (body.quietStart === '') === (body.quietEnd === ''), {
    message: 'Set both ends of the quiet hours, or neither.',
    path: ['quietEnd'],
  });
export type SaveHouseholdChannelInput = z.infer<typeof saveHouseholdChannelSchema>;
