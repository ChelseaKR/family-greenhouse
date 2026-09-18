/**
 * The household chat channel (#674): connecting one, posting to one, and what
 * a failed post does to it.
 *
 * Shared by the admin routes (`handlers/households/channelNotifier.ts`) and
 * the hourly pass (`services/householdChannelRun.ts`), so a test post and a
 * scheduled post take exactly the same path from sealed address to socket.
 *
 * ## Failure policy — never a retry storm
 *
 * A post is attempted at most once per channel per hourly run, and never
 * retried inside a run. After a failure the channel backs off (1h, 2h, 4h …
 * capped at 24h; a 429's `Retry-After` is honoured when longer), and delivery
 * STOPS — `status: 'disabled'`, with a reason the settings page shows — on:
 *
 *   - `CHANNEL_MAX_CLIENT_ERRORS` consecutive 4xx/3xx answers. Discord and
 *     Slack answer 404/401/403/410 for a webhook that was deleted, rotated or
 *     whose channel was archived; hammering it helps nobody.
 *   - any answer from a non-public address (`blocked`): the configuration is
 *     unsafe, not flaky.
 *   - `CHANNEL_MAX_FAILURES` consecutive failures of any kind — about five
 *     days of an endpoint that never answers.
 *
 * A 429 counts as a failure for backoff but not towards the 4xx limit: being
 * rate-limited says nothing about whether the webhook still exists.
 *
 * Re-enabling is an admin action: paste the address again, or send a test
 * message that lands.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import {
  CHANNEL_MAX_CLIENT_ERRORS,
  CHANNEL_MAX_FAILURES,
  backoffMs,
  parseWebhookUrl,
  type ChannelDisabledReason,
  type DeliveryFailureKind,
  type HouseholdChannelRecord,
  type SaveHouseholdChannelInput,
  type WebhookUrlProblem,
} from '../models/householdChannel.js';
import { isValidTimeZone } from '../utils/timeZone.js';
import { openWebhookUrl, sealWebhookUrl } from './channelSecret.js';
import { checkHostResolvesPublic } from './channelSsrfGuard.js';
import { postWebhook } from './channelWebhookTransport.js';
import { composeTest, renderForPlatform, type ComposedChannelMessage } from './channelMessages.js';
import * as store from './householdChannelStore.js';

export type DeliveryAttempt =
  | { ok: true; httpStatus: number }
  | {
      ok: false;
      kind: DeliveryFailureKind;
      httpStatus: number | null;
      retryAfterSeconds: number | null;
    };

export interface DeliveryDeps {
  open: typeof openWebhookUrl;
  post: typeof postWebhook;
}

const DEFAULT_DELIVERY_DEPS: DeliveryDeps = { open: openWebhookUrl, post: postWebhook };

/**
 * Unseal, render and post one message. Never throws. The plaintext address
 * exists only inside this function's scope and is handed to the transport and
 * nowhere else — not to a log line, not to a return value.
 */
export async function attemptDelivery(
  record: HouseholdChannelRecord,
  message: ComposedChannelMessage,
  deps: DeliveryDeps = DEFAULT_DELIVERY_DEPS
): Promise<DeliveryAttempt> {
  let url: string;
  try {
    url = await deps.open(record.householdId, record.sealedUrl);
  } catch (err) {
    logger.error(
      {
        householdId: record.householdId,
        errorName: (err as Error).name,
        msg: 'household_channel.unseal_failed',
      },
      'household_channel.unseal_failed'
    );
    return { ok: false, kind: 'unsealable', httpStatus: null, retryAfterSeconds: null };
  }
  const body = renderForPlatform(record.platform, message, record.locale);
  return deps.post(record.platform, url, body);
}

/** What a landed post does to the row: the streak is over. */
export function successPatch(now: Date): store.ChannelOutcomePatch {
  return {
    status: 'active',
    disabledReason: null,
    consecutiveFailures: 0,
    consecutiveClientErrors: 0,
    nextAttemptAt: null,
    lastFailure: null,
    lastDeliveredAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * What a failed post does to the row. Pure, so the whole policy is one table
 * in the tests.
 */
export function failurePatch(
  record: Pick<HouseholdChannelRecord, 'consecutiveFailures' | 'consecutiveClientErrors'>,
  attempt: Extract<DeliveryAttempt, { ok: false }>,
  now: Date
): store.ChannelOutcomePatch {
  const failures = record.consecutiveFailures + 1;
  const refusal = attempt.kind === 'client' || attempt.kind === 'redirect';
  const clientErrors = refusal
    ? record.consecutiveClientErrors + 1
    : attempt.kind === 'rate_limited'
      ? record.consecutiveClientErrors
      : 0;

  let disabledReason: ChannelDisabledReason | null = null;
  if (attempt.kind === 'blocked') disabledReason = 'blocked_address';
  else if (refusal && clientErrors >= CHANNEL_MAX_CLIENT_ERRORS) {
    disabledReason = attempt.kind === 'redirect' ? 'redirect' : 'repeated_client_errors';
  } else if (failures >= CHANNEL_MAX_FAILURES) disabledReason = 'repeated_failures';

  return {
    consecutiveFailures: failures,
    consecutiveClientErrors: clientErrors,
    nextAttemptAt: new Date(
      now.getTime() + backoffMs(failures, attempt.retryAfterSeconds)
    ).toISOString(),
    lastFailure: { at: now.toISOString(), kind: attempt.kind, httpStatus: attempt.httpStatus },
    ...(disabledReason ? { status: 'disabled' as const, disabledReason } : {}),
    updatedAt: now.toISOString(),
  };
}

/**
 * Record a scheduled attempt's outcome against the row it was made with.
 * Returns the patch that was applied, or null when the channel changed under
 * us (see `store.applyOutcome`).
 */
export async function recordOutcome(
  record: HouseholdChannelRecord,
  attempt: DeliveryAttempt,
  now: Date
): Promise<store.ChannelOutcomePatch | null> {
  const patch = attempt.ok ? successPatch(now) : failurePatch(record, attempt, now);
  const applied = await store.applyOutcome(record.householdId, record.urlVersion, patch);
  if (!attempt.ok) {
    logger.warn(
      {
        householdId: record.householdId,
        platform: record.platform,
        kind: attempt.kind,
        httpStatus: attempt.httpStatus,
        consecutiveFailures: patch.consecutiveFailures,
        msg: 'household_channel.delivery_failed',
      },
      'household_channel.delivery_failed'
    );
    if (patch.status === 'disabled' && applied === 'applied') {
      // The admin learns this from the settings page (`status`,
      // `disabledReason`); this line is for us.
      logger.warn(
        {
          householdId: record.householdId,
          platform: record.platform,
          reason: patch.disabledReason,
          msg: 'household_channel.disabled',
        },
        'household_channel.disabled'
      );
    }
  }
  return applied === 'applied' ? patch : null;
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

export type SaveChannelResult =
  | { status: 'saved'; record: HouseholdChannelRecord }
  | { status: 'invalid_url'; problem: WebhookUrlProblem | 'url_required' | 'unresolvable' }
  | { status: 'invalid_timezone' }
  | { status: 'conflict' };

export interface SaveChannelDeps {
  seal: typeof sealWebhookUrl;
  checkHost: typeof checkHostResolvesPublic;
}

const DEFAULT_SAVE_DEPS: SaveChannelDeps = {
  seal: sealWebhookUrl,
  checkHost: checkHostResolvesPublic,
};

/**
 * Connect a channel, replace its address, or change its settings.
 *
 * A new address is validated structurally, then its host is resolved and
 * refused if any answer is non-public — an early, friendly answer; the real
 * boundary is the per-delivery guard. Sealing happens last, so an address
 * that fails either check is never sent to KMS at all.
 *
 * Replacing the address starts a clean slate: a new `urlVersion`, status
 * `active`, and no failure history (the old address's 404s are not the new
 * one's). Changing only the settings keeps all of that, so a disabled channel
 * stays disabled until its address is re-entered or a test post lands.
 */
export async function saveChannel(
  householdId: string,
  actorId: string,
  input: SaveHouseholdChannelInput,
  now: Date = new Date(),
  deps: SaveChannelDeps = DEFAULT_SAVE_DEPS
): Promise<SaveChannelResult> {
  if (!isValidTimeZone(input.timezone)) return { status: 'invalid_timezone' };
  const existing = await store.getChannel(householdId);
  const stamp = now.toISOString();

  const settings = {
    events: { dailyDue: input.events.dailyDue, upForGrabs: input.events.upForGrabs },
    quietStart: input.quietStart,
    quietEnd: input.quietEnd,
    timezone: input.timezone,
    locale: input.locale,
  };

  const needsUrl = !existing || existing.platform !== input.platform;
  if (!input.url) {
    if (needsUrl || !existing) return { status: 'invalid_url', problem: 'url_required' };
    const saved = await store.saveChannel(
      { ...existing, ...settings, updatedAt: stamp },
      existing.updatedAt
    );
    return saved === 'saved'
      ? { status: 'saved', record: { ...existing, ...settings, updatedAt: stamp } }
      : { status: 'conflict' };
  }

  const parsed = parseWebhookUrl(input.platform, input.url);
  if (!parsed.ok) return { status: 'invalid_url', problem: parsed.problem };
  const host = await deps.checkHost(parsed.host);
  if (host === 'blocked') return { status: 'invalid_url', problem: 'private_host' };
  if (host === 'unresolvable') return { status: 'invalid_url', problem: 'unresolvable' };

  const sealedUrl = await deps.seal(householdId, parsed.url.toString());
  const record: HouseholdChannelRecord = {
    householdId,
    platform: input.platform,
    sealedUrl,
    urlVersion: randomUUID(),
    host: parsed.host,
    last4: parsed.last4,
    ...settings,
    status: 'active',
    disabledReason: null,
    consecutiveFailures: 0,
    consecutiveClientErrors: 0,
    nextAttemptAt: null,
    lastFailure: null,
    lastDeliveredAt: null,
    lastTestAt: existing?.lastTestAt ?? null,
    connectedBy: actorId,
    connectedAt: stamp,
    updatedAt: stamp,
  };
  const saved = await store.saveChannel(record, existing ? existing.updatedAt : null);
  return saved === 'saved' ? { status: 'saved', record } : { status: 'conflict' };
}

/** Minimum gap between two test posts from one household, whoever sends them.
 *  The per-user route limit is in-memory per container; this one is not. */
export const CHANNEL_TEST_COOLDOWN_MS = 30_000;

export type TestPostResult =
  | { status: 'none' }
  | { status: 'cooldown'; retryAfterSeconds: number }
  | { status: 'sent'; record: HouseholdChannelRecord }
  | {
      status: 'failed';
      kind: DeliveryFailureKind;
      httpStatus: number | null;
      record: HouseholdChannelRecord;
    };

/**
 * The admin's "send a test message". Ignores quiet hours and backoff — a
 * person pressed a button — but not the cooldown.
 *
 * A test that lands clears the failure history and re-enables a disabled
 * channel: it has just proved the address works. A test that fails changes
 * nothing but `lastTestAt`; the admin sees the reason in the response, and
 * one bad test must not count towards switching the channel off.
 */
export async function sendTestPost(
  householdId: string,
  now: Date = new Date(),
  deps: DeliveryDeps = DEFAULT_DELIVERY_DEPS
): Promise<TestPostResult> {
  const record = await store.getChannel(householdId);
  if (!record) return { status: 'none' };
  const last = record.lastTestAt ? Date.parse(record.lastTestAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < CHANNEL_TEST_COOLDOWN_MS) {
    return {
      status: 'cooldown',
      retryAfterSeconds: Math.ceil((CHANNEL_TEST_COOLDOWN_MS - (now.getTime() - last)) / 1000),
    };
  }
  // Claim the cooldown before the network call, so two clicks cannot both post.
  const claimed = await store.applyOutcome(householdId, record.urlVersion, {
    lastTestAt: now.toISOString(),
  });
  if (claimed === 'stale') return { status: 'none' };

  const attempt = await attemptDelivery(record, composeTest(record.events, record.locale), deps);
  if (attempt.ok) {
    const patch = successPatch(now);
    await store.applyOutcome(householdId, record.urlVersion, patch);
    return { status: 'sent', record: { ...record, ...patch, lastTestAt: now.toISOString() } };
  }
  logger.info(
    {
      householdId,
      platform: record.platform,
      kind: attempt.kind,
      httpStatus: attempt.httpStatus,
      msg: 'household_channel.test_failed',
    },
    'household_channel.test_failed'
  );
  return {
    status: 'failed',
    kind: attempt.kind,
    httpStatus: attempt.httpStatus,
    record: { ...record, lastTestAt: now.toISOString() },
  };
}
