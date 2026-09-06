import { createSign } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
// Borrowed from the SMS channel rather than written twice: APNs caps the
// collapse id in BYTES, the same units and the same code-point-splitting
// hazard `truncateToBytes` was written for.
import { truncateToBytes } from './smsNotifier.js';

/**
 * Firebase Cloud Messaging HTTP v1 transport for native (iOS/Android) push.
 *
 * The sibling of `web-push` in `notifier.sendBrowserPush`: this module owns
 * the provider protocol, `notifier.sendDevicePush` owns the fan-out and the
 * dead-token cleanup. iOS goes through FCM as well rather than talking to
 * APNs directly — the APNs key is uploaded to the same Firebase project (see
 * docs/mobile.md § Push notifications), so one credential and one code path
 * cover both shells.
 *
 * FCM v1 authenticates with a short-lived OAuth2 access token derived from a
 * service-account key, which is why this file signs a JWT with `node:crypto`
 * instead of pulling in `google-auth-library` or `firebase-admin`. Both are
 * large, and everything they would be used for here is one RS256 signature
 * and two `fetch` calls. `backend/esbuild.config.js` bundles this into every
 * notification Lambda, so the bundle cost would be paid on every cold start.
 *
 * NOTHING IS CONFIGURED IN ANY ENVIRONMENT TODAY. `FCM_SERVICE_ACCOUNT_SECRET_ID`
 * is blank everywhere, so `sendDevicePushMessages` answers `unconfigured`
 * after one info line per Lambda container and never makes a network call.
 * That is the state this ships in: the Firebase project, the APNs key and the
 * service-account JSON are all maintainer-side work.
 */

/**
 * The fields of a Google service-account JSON this module actually uses.
 *
 * Parsed rather than cast because the value arrives from Secrets Manager as
 * an opaque string: a truncated paste or the wrong secret must fail here,
 * once, with a name — not as a `TypeError` inside `createSign` on every
 * reminder run.
 */
const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().min(1).optional(),
});

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/**
 * Why device push is or is not able to send right now.
 *
 * Three states, not a boolean, because they have different consequences.
 * `unconfigured` is the settled, expected state of every environment today
 * and must never be retried or logged again. `unavailable` is a Secrets
 * Manager read that failed or a secret that would not parse — a real problem,
 * worth a warning, and worth retrying after a cooldown rather than never
 * again or once a minute.
 */
type CredentialState =
  | { status: 'ready'; account: ServiceAccount }
  | { status: 'unconfigured' }
  | { status: 'unavailable' };

/** Per-token result. `token_dead` is the only one that prunes storage. */
export type DevicePushOutcome = 'delivered' | 'token_dead' | 'failed' | 'unconfigured';

export interface DevicePushMessage {
  /** APNs/FCM registration token, as registered by the Capacitor shells. */
  token: string;
  title: string;
  body: string;
  /** Deep link carried in the data payload for the shell to open on tap. */
  url?: string;
  /** Collapse key — a newer reminder replaces an unread older one. */
  tag?: string;
}

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ASSERTION_LIFETIME_SECONDS = 3_600;
/** Mint a new access token this long before the current one expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/**
 * Same 5s bound `sendBrowserPush` puts on web-push: one degraded provider
 * must not be able to consume the reminder Lambda's whole timeout.
 */
const REQUEST_TIMEOUT_MS = 5_000;
/**
 * How long a failed credential read stays failed before we try again. A
 * throttled or briefly unreachable Secrets Manager should not disable device
 * push until the container recycles, but neither should every reminder run
 * re-attempt it and log about it.
 */
const CREDENTIAL_RETRY_MS = 15 * 60_000;
/** APNs rejects a collapse id longer than 64 bytes. */
const MAX_COLLAPSE_ID_BYTES = 64;

let secretsClient: SecretsManagerClient | null = null;

function secrets(): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return secretsClient;
}

let credentialCache: { state: CredentialState; until: number } | undefined;
let unconfiguredAnnounced = false;
let accessToken: { value: string; expiresAt: number; clientEmail: string } | undefined;
let accessTokenInFlight: Promise<string> | undefined;

/** Test seam — module-level caches would otherwise leak between cases. */
export function __resetFcmStateForTests(): void {
  credentialCache = undefined;
  unconfiguredAnnounced = false;
  accessToken = undefined;
  accessTokenInFlight = undefined;
  secretsClient = null;
}

/**
 * Resolve the service account, at most once per container while it succeeds
 * and at most once per {@link CREDENTIAL_RETRY_MS} while it does not.
 *
 * The unconfigured branch is the one this whole file is shaped around. It is
 * reached on every reminder run in every environment, so it must cost nothing
 * and say nothing after the first time: one `device_push_unconfigured` info
 * line per container, then silence. It is deliberately NOT a warning — an
 * unconfigured optional channel is the documented state of the product, not a
 * fault, and warning about it hourly would train everyone to ignore the
 * notification Lambdas' logs.
 */
async function resolveCredentials(): Promise<CredentialState> {
  if (credentialCache && Date.now() < credentialCache.until) return credentialCache.state;

  const secretId = process.env.FCM_SERVICE_ACCOUNT_SECRET_ID?.trim();
  if (!secretId) {
    if (!unconfiguredAnnounced) {
      unconfiguredAnnounced = true;
      logger.info({ msg: 'device_push_unconfigured' }, 'device_push_unconfigured');
    }
    credentialCache = { state: { status: 'unconfigured' }, until: Number.POSITIVE_INFINITY };
    return credentialCache.state;
  }

  try {
    const result = await secrets().send(new GetSecretValueCommand({ SecretId: secretId }));
    const raw = result.SecretString?.trim();
    if (!raw) throw new Error('secret has no string value');
    const parsed = serviceAccountSchema.parse(JSON.parse(raw));
    credentialCache = {
      state: {
        status: 'ready',
        account: {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
          tokenUri: parsed.token_uri ?? DEFAULT_TOKEN_URI,
        },
      },
      until: Number.POSITIVE_INFINITY,
    };
    return credentialCache.state;
  } catch (err) {
    // A NAMED state, not `unconfigured`: "the secret is set and we could not
    // read it" is an operational fault someone has to fix, and collapsing it
    // into the same answer as "device push was never set up" would hide it
    // behind the one state this system expects to be in forever.
    logger.warn(
      { err, retryAfterMs: CREDENTIAL_RETRY_MS, msg: 'device_push_credentials_unavailable' },
      'device_push_credentials_unavailable'
    );
    credentialCache = { state: { status: 'unavailable' }, until: Date.now() + CREDENTIAL_RETRY_MS };
    return credentialCache.state;
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * The signed JWT bearer assertion Google exchanges for an access token
 * (RFC 7523 profile, `urn:ietf:params:oauth:grant-type:jwt-bearer`).
 */
function signedAssertion(account: ServiceAccount, now: number): string {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: OAUTH_SCOPE,
      aud: account.tokenUri,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    })
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(account.privateKey)
    .toString('base64url');
  return `${header}.${claims}.${signature}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().finite().positive(),
});

/** Exchange the assertion for an access token. Throws; the caller names it. */
async function fetchAccessToken(
  account: ServiceAccount
): Promise<{ value: string; expiresAt: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(account.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedAssertion(account, Date.now()),
      }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Google token endpoint returned HTTP ${response.status}`);
    }
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error('Google token endpoint returned an unrecognised response');
    }
    return {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1_000,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The current access token, minted once and shared.
 *
 * `accessTokenInFlight` is not an optimisation. A household reminder run
 * fans out per user, and a cold container would otherwise mint one token per
 * concurrent send — the same credential, several times, against an endpoint
 * that rate-limits.
 */
async function currentAccessToken(account: ServiceAccount): Promise<string> {
  const cached = accessToken;
  if (
    cached &&
    cached.clientEmail === account.clientEmail &&
    Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS
  ) {
    return cached.value;
  }
  if (!accessTokenInFlight) {
    accessTokenInFlight = fetchAccessToken(account)
      .then((minted) => {
        accessToken = { ...minted, clientEmail: account.clientEmail };
        return minted.value;
      })
      .finally(() => {
        accessTokenInFlight = undefined;
      });
  }
  return await accessTokenInFlight;
}

const fcmErrorSchema = z.object({
  error: z
    .object({
      status: z.string().optional(),
      message: z.string().optional(),
      details: z.array(z.object({ errorCode: z.string().optional() })).optional(),
    })
    .optional(),
});

/**
 * Registration-token states FCM reports as permanent.
 *
 * This is the native half of the 404/410 rule `sendBrowserPush` applies to
 * web-push endpoints. FCM v1 answers HTTP 404 with `UNREGISTERED` when the
 * app has been uninstalled or the token rotated.
 *
 * `INVALID_ARGUMENT` (HTTP 400) is DELIBERATELY not here, and that is the
 * important omission. FCM returns it both for a token it cannot parse and
 * for a message body it cannot parse — so a bug in the payload this file
 * builds would come back as `INVALID_ARGUMENT` for every token of every user,
 * and pruning on it would delete the entire installed base's push
 * registrations in one reminder run. A stale token that lingers costs one
 * failed request an hour; the other mistake is not recoverable from our side.
 */
const DEAD_TOKEN_ERROR_CODES = new Set(['UNREGISTERED', 'NOT_FOUND']);

/** The FCM v1 message body for one device. */
function messageBody(message: DevicePushMessage): Record<string, unknown> {
  const collapseId = message.tag ? truncateToBytes(message.tag, MAX_COLLAPSE_ID_BYTES) : undefined;
  return {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      // `data` is what the shell reads on tap. Strings only — FCM rejects
      // any other JSON type in this map.
      ...(message.url ? { data: { url: message.url } } : {}),
      ...(collapseId
        ? {
            android: { collapse_key: collapseId, notification: { tag: collapseId } },
            apns: { headers: { 'apns-collapse-id': collapseId } },
          }
        : {}),
    },
  };
}

async function sendOne(
  account: ServiceAccount,
  bearer: string,
  message: DevicePushMessage
): Promise<DevicePushOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messageBody(message)),
        signal: controller.signal,
      }
    );
    if (response.ok) return 'delivered';

    const parsed = fcmErrorSchema.safeParse(await response.json().catch(() => ({})));
    const detail = parsed.success ? parsed.data.error : undefined;
    const errorCodes = [
      detail?.status,
      ...(detail?.details ?? []).map((entry) => entry.errorCode),
    ].filter((code): code is string => typeof code === 'string');
    if (response.status === 404 || errorCodes.some((code) => DEAD_TOKEN_ERROR_CODES.has(code))) {
      return 'token_dead';
    }
    // Never log the token itself; the logger redacts a `token` field, but the
    // host and status are what a human debugging this actually needs.
    logger.warn(
      { status: response.status, errorCodes, msg: 'device_push_failed' },
      'device_push_failed'
    );
    return 'failed';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send one notification to each of `messages`, returning an outcome per
 * message in the same order.
 *
 * Batched rather than one call per token so the credential read and the
 * access-token exchange happen once for the whole fan-out. Returns
 * `unconfigured` for every message — without any network call — whenever the
 * service account is absent or unreadable, which is every environment today.
 */
export async function sendDevicePushMessages(
  messages: readonly DevicePushMessage[]
): Promise<DevicePushOutcome[]> {
  if (messages.length === 0) return [];
  const credentials = await resolveCredentials();
  if (credentials.status !== 'ready') return messages.map(() => 'unconfigured');

  let bearer: string;
  try {
    bearer = await currentAccessToken(credentials.account);
  } catch (err) {
    // Nothing was attempted, so nothing may be pruned. `failed` keeps every
    // token exactly where it is and lets the next run try again.
    logger.warn({ err, msg: 'device_push_auth_failed' }, 'device_push_auth_failed');
    return messages.map(() => 'failed');
  }

  return await Promise.all(
    messages.map(async (message) => {
      try {
        return await sendOne(credentials.account, bearer, message);
      } catch (err) {
        // A network error or the 5s abort. Transient by construction — a
        // timeout says nothing about whether the token is still registered.
        logger.warn({ err, msg: 'device_push_failed' }, 'device_push_failed');
        return 'failed' as const;
      }
    })
  );
}
